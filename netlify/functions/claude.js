const { handleRequest } = require("../../lib/handler");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const body = JSON.parse(event.body);
    const { statusCode, body: resBody } = await handleRequest(body);
    return { statusCode, headers, body: JSON.stringify(resBody) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
