// Shared request handler for both Netlify Functions and Vercel Serverless Functions.
// Takes an already-parsed JSON body, returns { statusCode, body: <object> }.

// ── Daily usage cap ─────────────────────────────────────────────────────────
// Best-effort per-IP limit held in instance memory: survives warm invocations,
// resets on cold starts / across instances. Good enough as a cost guard.
const DAILY_LIMIT = 5;
const usageByIpDay = new Map(); // "ip|YYYY-MM-DD" -> count

function consumeDailyUse(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${ip}|${today}`;
  if (usageByIpDay.size > 5000) {
    for (const k of usageByIpDay.keys()) if (!k.endsWith(today)) usageByIpDay.delete(k);
  }
  const used = usageByIpDay.get(key) || 0;
  if (used >= DAILY_LIMIT) return -1;
  usageByIpDay.set(key, used + 1);
  return DAILY_LIMIT - (used + 1);
}

async function handleRequest(body, clientIp = "unknown") {
  // ── DEEP SCRAPE ────────────────────────────────────────────────────────────
  if (body.action === "scrape") {
    const baseUrl = body.url;
    let crawledUrls = [baseUrl];
    let stylesheetUrls = [];
    let siteData = {
      title: "", description: "", ogTitle: "", ogImage: "",
      h1s: [], h2s: [], h3s: [], paragraphs: [],
      colors: {}, fonts: [], links: [], metaKeywords: "",
      navItems: [], footerText: "", ctaTexts: []
    };

    const fetchText = async (url) => {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,text/css;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(7000),
        });
        if (!res.ok) return null;
        return await res.text();
      } catch { return null; }
    };

    const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    // ── Weighted color scoring ──
    // Colors aren't equal signals: theme-color meta >> backgrounds/buttons >> any hex in markup.
    const normalizeHex = (raw) => {
      let h = raw.toLowerCase().replace('#', '');
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      if (h.length === 8) h = h.slice(0, 6); // drop alpha channel
      if (h.length !== 6 || /[^0-9a-f]/.test(h)) return null;
      return '#' + h;
    };
    const addColor = (hex, weight = 1) => {
      const norm = normalizeHex(hex);
      if (!norm) return;
      const r = parseInt(norm.slice(1, 3), 16), g = parseInt(norm.slice(3, 5), 16), b = parseInt(norm.slice(5, 7), 16);
      const lum = (r + g + b) / 3;
      if (lum <= 16 || lum >= 244) return; // near-black / near-white
      siteData.colors[norm] = (siteData.colors[norm] || 0) + weight;
    };
    const rgbToHex = (r, g, b) => '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');

    // Extract colors from any chunk of CSS-ish text with context weighting
    const extractColors = (text, baseWeight = 1) => {
      if (!text) return;
      // Brand-signal contexts get boosted: backgrounds, buttons, accents, brand/primary vars
      [...text.matchAll(/(background(?:-color)?|--[a-z-]*(?:primary|brand|accent|main|theme)[a-z-]*|border(?:-color)?)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([\d\s.,%]+\))/gi)].forEach(m => {
        const val = m[2];
        const boost = /background|primary|brand|accent|theme|main/i.test(m[1]) ? 5 : 2;
        const rgb = val.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
        if (rgb) addColor(rgbToHex(+rgb[1], +rgb[2], +rgb[3]), baseWeight * boost);
        else addColor(val, baseWeight * boost);
      });
      // SVG fills/strokes — logos live here
      [...text.matchAll(/(?:fill|stroke)=["'](#[0-9a-fA-F]{3,8})["']/g)].forEach(m => addColor(m[1], baseWeight * 3));
      [...text.matchAll(/(?:fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8})\b/gi)].forEach(m => addColor(m[1], baseWeight * 3));
      // Generic hex + rgb occurrences (low weight)
      (text.match(/#[0-9a-fA-F]{6}\b/g) || []).forEach(c => addColor(c, baseWeight));
      (text.match(/#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g) || []).forEach(c => addColor(c, baseWeight));
      [...text.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g)].forEach(m => addColor(rgbToHex(+m[1], +m[2], +m[3]), baseWeight));
    };

    const extractFonts = (text) => {
      if (!text) return;
      [...text.matchAll(/font-family\s*:\s*([^;}{]+)/gi)].forEach(m => {
        const f = m[1].trim().split(',')[0].replace(/['"]/g, '').trim();
        if (f && !/^(inherit|initial|unset|var\(|-apple)/.test(f) && !siteData.fonts.includes(f) && f.length < 40) siteData.fonts.push(f);
      });
      [...text.matchAll(/fonts\.googleapis\.com\/css[^"')]*family=([^&"')|]+)/g)].forEach(m => {
        const f = decodeURIComponent(m[1]).replace(/\+/g, ' ').split(':')[0];
        if (f && !siteData.fonts.includes(f)) siteData.fonts.push(f);
      });
    };

    const parseHtml = (html, url) => {
      if (!html) return;

      // Title & meta
      if (!siteData.title) {
        const m = html.match(/<title[^>]*>(.*?)<\/title>/i);
        if (m) siteData.title = stripTags(m[1]);
      }
      const desc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']{10,})/i);
      if (desc && !siteData.description) siteData.description = desc[1];
      const ogT = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i);
      if (ogT && !siteData.ogTitle) siteData.ogTitle = ogT[1];
      const ogI = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i);
      if (ogI && !siteData.ogImage) siteData.ogImage = ogI[1];
      const kw = html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']+)/i);
      if (kw) siteData.metaKeywords = kw[1];

      // theme-color / tile-color metas are the strongest brand-color signal a site can send
      [...html.matchAll(/<meta[^>]*name=["'](?:theme-color|msapplication-TileColor)["'][^>]*content=["'](#[0-9a-fA-F]{3,8})["']/gi)].forEach(m => addColor(m[1], 40));
      [...html.matchAll(/<meta[^>]*content=["'](#[0-9a-fA-F]{3,8})["'][^>]*name=["'](?:theme-color|msapplication-TileColor)["']/gi)].forEach(m => addColor(m[1], 40));

      // Headings
      [...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/gis)].forEach(m => {
        const t = stripTags(m[1]); if (t.length > 2) siteData.h1s.push(t);
      });
      [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gis)].forEach(m => {
        const t = stripTags(m[1]); if (t.length > 2) siteData.h2s.push(t);
      });
      [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/gis)].forEach(m => {
        const t = stripTags(m[1]); if (t.length > 2) siteData.h3s.push(t);
      });

      // Paragraphs (meaningful ones)
      [...html.matchAll(/<p[^>]*>(.*?)<\/p>/gis)].forEach(m => {
        const t = stripTags(m[1]); if (t.length > 40) siteData.paragraphs.push(t);
      });

      // Button/CTA text
      [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gis)].forEach(m => {
        const t = stripTags(m[1]); if (t.length > 1 && t.length < 60) siteData.ctaTexts.push(t);
      });
      [...html.matchAll(/<a[^>]*class=["'][^"']*btn[^"']*["'][^>]*>(.*?)<\/a>/gis)].forEach(m => {
        const t = stripTags(m[1]); if (t.length > 1 && t.length < 60) siteData.ctaTexts.push(t);
      });

      // Colors & fonts from inline styles + <style> blocks
      extractColors(html, 1);
      extractFonts(html);

      // External stylesheets to fetch (both attribute orders)
      [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].forEach(m => {
        try { const u = new URL(m[1], url).href; if (!stylesheetUrls.includes(u) && stylesheetUrls.length < 6) stylesheetUrls.push(u); } catch {}
      });
      [...html.matchAll(/<link[^>]*href=["']([^"']+\.css[^"']*)["'][^>]*>/gi)].forEach(m => {
        try { const u = new URL(m[1], url).href; if (!stylesheetUrls.includes(u) && stylesheetUrls.length < 6) stylesheetUrls.push(u); } catch {}
      });

      // Nav items
      [...html.matchAll(/<nav[^>]*>(.*?)<\/nav>/gis)].forEach(m => {
        [...m[1].matchAll(/<a[^>]*>(.*?)<\/a>/gi)].forEach(a => {
          const t = stripTags(a[1]); if (t.length > 1 && t.length < 30) siteData.navItems.push(t);
        });
      });

      // Internal links to crawl
      const base = new URL(url);
      [...html.matchAll(/href=["']([^"'#?]+)["']/g)].forEach(m => {
        try {
          const u = new URL(m[1], url);
          if (u.hostname === base.hostname && !crawledUrls.includes(u.href) && crawledUrls.length < 6) {
            const path = u.pathname;
            if (!path.match(/\.(css|js|png|jpg|svg|pdf|xml|ico)/i)) {
              crawledUrls.push(u.href);
            }
          }
        } catch {}
      });
    };

    // Fetch home page first
    const homeHtml = await fetchText(baseUrl);
    parseHtml(homeHtml, baseUrl);

    // Crawl up to 4 more pages + external stylesheets in parallel
    const additionalUrls = crawledUrls.slice(1, 5);
    const [additionalPages, stylesheets] = await Promise.all([
      Promise.all(additionalUrls.map(u => fetchText(u))),
      Promise.all(stylesheetUrls.map(u => fetchText(u))),
    ]);
    additionalPages.forEach((html, i) => parseHtml(html, additionalUrls[i]));
    stylesheets.forEach(css => { extractColors(css, 1); extractFonts(css); });

    // ── Palette selection: filter grays, merge near-duplicates, enforce diversity ──
    const hexToHsl = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h = 0; const l = (max + min) / 2;
      const d = max - min;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
      }
      return { h, s, l };
    };
    const rgbDist = (a, b) => {
      const pr = parseInt(a.slice(1, 3), 16) - parseInt(b.slice(1, 3), 16);
      const pg = parseInt(a.slice(3, 5), 16) - parseInt(b.slice(3, 5), 16);
      const pb = parseInt(a.slice(5, 7), 16) - parseInt(b.slice(5, 7), 16);
      return Math.sqrt(pr * pr + pg * pg + pb * pb);
    };

    const ranked = Object.entries(siteData.colors).sort((a, b) => b[1] - a[1]);
    const saturated = ranked.filter(([hex]) => hexToHsl(hex).s >= 0.15);
    const pool = saturated.length >= 3 ? saturated : ranked; // fall back for genuinely gray sites

    // Greedy pick by score; merge near-duplicate shades into the stronger one
    const picked = [];
    for (const [hex, score] of pool) {
      const near = picked.find(p => rgbDist(p.hex, hex) < 50);
      if (near) { near.score += score; continue; }
      picked.push({ hex, score, hsl: hexToHsl(hex) });
      if (picked.length >= 24) break;
    }
    // Re-rank after merging, then prefer hue diversity: don't let one hue family fill the list
    picked.sort((a, b) => b.score - a.score);
    const diverse = [];
    for (const c of picked) {
      const sameHueCount = diverse.filter(d => Math.abs(d.hsl.h - c.hsl.h) < 25 || Math.abs(d.hsl.h - c.hsl.h) > 335).length;
      if (sameHueCount >= 3) continue; // cap 3 shades per hue family
      diverse.push(c);
      if (diverse.length >= 15) break;
    }
    const sortedColors = diverse.map(c => c.hex);

    return {
      statusCode: 200,
      body: {
        scraped: true,
        pagesScanned: crawledUrls.length,
        data: {
          ...siteData,
          sortedColors,
          h1s: [...new Set(siteData.h1s)].slice(0, 6),
          h2s: [...new Set(siteData.h2s)].slice(0, 10),
          h3s: [...new Set(siteData.h3s)].slice(0, 8),
          paragraphs: [...new Set(siteData.paragraphs)].slice(0, 8),
          fonts: [...new Set(siteData.fonts)].slice(0, 8),
          ctaTexts: [...new Set(siteData.ctaTexts)].slice(0, 10),
          navItems: [...new Set(siteData.navItems)].slice(0, 10),
        }
      }
    };
  }

  // ── GENERATE / REGENERATE SECTION ─────────────────────────────────────────
  if (body.action === "generate") {
    if (!process.env.ANTHROPIC_API_KEY) {
      return {
        statusCode: 500,
        body: { error: "Server is missing ANTHROPIC_API_KEY. Set it in your hosting provider's environment variables and redeploy." },
      };
    }

    const { siteData, section, url, currentBrand, optsSuffix = "" } = body;

    // Full scans count against the daily cap; per-section regenerates don't.
    let remaining = null;
    if (section === "full") {
      remaining = consumeDailyUse(clientIp);
      if (remaining < 0) {
        return {
          statusCode: 429,
          body: { error: `Daily limit reached — ${DAILY_LIMIT} scans per day. Come back tomorrow.` },
        };
      }
    }

    let prompt = "";

    if (section === "full") {
      prompt = `You are a world-class brand strategist analyzing a REAL website. Generate an accurate brand guide based on this scraped data.

URL: ${url}
Pages scanned: ${siteData.pagesScanned || 1}

SITE DATA:
Title: ${siteData.title}
OG Title: ${siteData.ogTitle}
Meta Description: ${siteData.description}
Keywords: ${siteData.metaKeywords}
H1 Headings: ${siteData.h1s?.join(' | ')}
H2 Headings: ${siteData.h2s?.join(' | ')}
H3 Headings: ${siteData.h3s?.join(' | ')}
Sample Paragraphs: ${siteData.paragraphs?.slice(0,4).join(' || ')}
Navigation Items: ${siteData.navItems?.join(', ')}
CTA Button Texts: ${siteData.ctaTexts?.join(', ')}
Detected Hex Colors (by frequency): ${siteData.sortedColors?.join(', ')}
Detected Fonts: ${siteData.fonts?.join(', ')}

CRITICAL RULES:
1. Colors: Use ONLY colors from the detected list if available. Pick the most visually dominant/frequent ones. If no colors detected, infer from the brand.
2. Fonts: Use detected fonts if found. Otherwise suggest fonts that match the brand personality.
3. Voice: Base tone STRICTLY on the actual headings and paragraph text found.
4. Brand name: Extract from title/og:title, NOT the URL.
5. Be accurate and specific — not generic.

Respond ONLY with valid JSON, no markdown, no backticks:

{
  "brandName": "Exact company name from site",
  "tagline": "Punchy tagline under 10 words based on their actual messaging",
  "description": "2-3 sentences about what this company actually does based on real content",
  "colors": [
    {"hex": "#XXXXXX", "name": "Descriptive color name", "role": "Primary"},
    {"hex": "#XXXXXX", "name": "Descriptive color name", "role": "Secondary"},
    {"hex": "#XXXXXX", "name": "Descriptive color name", "role": "Accent"},
    {"hex": "#XXXXXX", "name": "Descriptive color name", "role": "Background"},
    {"hex": "#XXXXXX", "name": "Descriptive color name", "role": "Text"}
  ],
  "typography": {
    "displayFont": {"name": "Font name", "style": "Bold", "usage": "Headlines, hero text"},
    "bodyFont": {"name": "Font name", "style": "Regular", "usage": "Body copy, UI text"},
    "accentFont": {"name": "Font name", "style": "Italic", "usage": "Quotes, callouts"}
  },
  "voiceAndTone": {
    "traits": ["Trait1","Trait2","Trait3","Trait4","Trait5"],
    "description": "2 sentences describing their actual communication style"
  },
  "logoConcept": "Logo description based on brand identity",
  "logoText": "Short logo mark text",
  "keyMessages": [
    {"type": "Value Proposition", "message": "Based on real site content"},
    {"type": "Elevator Pitch", "message": "Short pitch"},
    {"type": "Tagline Variant", "message": "Alternate tagline"},
    {"type": "Call to Action", "message": "Based on real CTAs found: ${siteData.ctaTexts?.slice(0,3).join(', ')}"}
  ],
  "fullGuide": "Detailed 600-word brand guide with sections: BRAND STORY, TARGET AUDIENCE, VISUAL IDENTITY, VOICE AND TONE, BRAND PILLARS, DOS AND DONTS. Base everything on the real site content."
}`;

    } else {
      const sectionPrompts = {
        colors: `Re-analyze ONLY the color palette for this brand. The detected colors from scanning ${siteData.pagesScanned} pages are: ${siteData.sortedColors?.join(', ')}. Current brand: ${currentBrand.brandName}. Choose 5 colors that best represent this brand. Respond ONLY with JSON: {"colors": [{"hex":"#XXXXXX","name":"Name","role":"Primary/Secondary/Accent/Background/Text"},...]}`,

        typography: `Re-analyze ONLY the typography for ${currentBrand.brandName}. Detected fonts from site: ${siteData.fonts?.join(', ') || 'none'}. Their content style from headings: "${siteData.h1s?.slice(0,3).join(' | ')}". Suggest 3 fonts. Respond ONLY with JSON: {"typography":{"displayFont":{"name":"","style":"","usage":""},"bodyFont":{"name":"","style":"","usage":""},"accentFont":{"name":"","style":"","usage":""}}}`,

        voiceAndTone: `Re-analyze ONLY the voice and tone for ${currentBrand.brandName}. Based on their actual copy: H1s: "${siteData.h1s?.join(' | ')}" H2s: "${siteData.h2s?.slice(0,5).join(' | ')}" Paragraphs: "${siteData.paragraphs?.slice(0,3).join(' || ')}". Respond ONLY with JSON: {"voiceAndTone":{"traits":["","","","",""],"description":""}}`,

        keyMessages: `Regenerate key messages for ${currentBrand.brandName}. Real CTAs found: ${siteData.ctaTexts?.join(', ')}. H1s: "${siteData.h1s?.join(' | ')}". Description: "${siteData.description}". Respond ONLY with JSON: {"keyMessages":[{"type":"Value Proposition","message":""},{"type":"Elevator Pitch","message":""},{"type":"Tagline Variant","message":""},{"type":"Call to Action","message":""}]}`,

        fullGuide: `Rewrite the full brand guide for ${currentBrand.brandName}. Use all available site data. Tagline: "${currentBrand.tagline}". Description: "${currentBrand.description}". Voice traits: ${currentBrand.voiceAndTone?.traits?.join(', ')}. H1s: "${siteData.h1s?.join(' | ')}". Paragraphs: "${siteData.paragraphs?.slice(0,3).join(' || ')}". Write a detailed 600-word guide. Respond ONLY with JSON: {"fullGuide":"..."}`,
      };

      prompt = sectionPrompts[section] || sectionPrompts.fullGuide;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: prompt }]
      }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      return {
        statusCode: 502,
        body: { error: `Claude API returned a non-JSON response (HTTP ${response.status}).` },
      };
    }

    if (!response.ok || data.type === "error") {
      const msg = data?.error?.message || `Claude API request failed (HTTP ${response.status}).`;
      return { statusCode: response.status || 502, body: { error: msg } };
    }

    const text = (data.content || []).map((b) => b.text || "").join("");
    if (!text) {
      return {
        statusCode: 502,
        body: { error: "Claude returned an empty response. Please try again." },
      };
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        statusCode: 502,
        body: { error: "Claude's response didn't contain valid JSON. Please try again." },
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return {
        statusCode: 502,
        body: { error: `Couldn't parse Claude's JSON response: ${e.message}` },
      };
    }

    return { statusCode: 200, body: remaining === null ? { result: parsed } : { result: parsed, remaining } };
  }

  return { statusCode: 400, body: { error: "Unknown action" } };
}

module.exports = { handleRequest };
