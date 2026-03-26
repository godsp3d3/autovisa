"use strict";

const { fetchAndCropCarImage } = require("./imageUtils");

module.exports = async function (context, req) {
  context.log("Processing request to fetch and validate car image.");

  try {
    const result = await fetchAndCropCarImage();

    if (!result || result.error || !result.cropped_image_url || !result.full_image_url) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: {
          error: result?.error || "Image processing failed.",
          details: result || null
        },
      };
      return;
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: result,
    };
  } catch (err) {
    context.log.error("Unhandled error:", err);

    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        error: err.message || "Unknown server error"
      },
    };
  }
};