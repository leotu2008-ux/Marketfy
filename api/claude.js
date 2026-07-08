const { handleRequest } = require("../lib/handler");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { statusCode, body: resBody } = await handleRequest(body || {});
    res.status(statusCode).json(resBody);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
