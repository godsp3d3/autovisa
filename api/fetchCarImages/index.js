"use strict";

const { fetchAndCropCarImage } = require("./imageUtils");

module.exports = async function (context, req) {
  context.log("Processing request to fetch and validate car image.");

  try {
    const result = await fetchAndCropCarImage();
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    context.log.error("Unhandled error:", err.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
