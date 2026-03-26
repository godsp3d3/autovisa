const { BlobServiceClient } = require("@azure/storage-blob");
const { fetchAndProcessImage } = require("./imageUtils");

module.exports = async function (context, req) {
  try {
    context.log("fetchCarImages called");

    const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
    const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const VISION_ENDPOINT = process.env.AZURE_VISION_ENDPOINT;
    const VISION_API_KEY = process.env.AZURE_VISION_API_KEY;

    let missing = [];
    if (!PIXABAY_API_KEY) missing.push("PIXABAY_API_KEY");
    if (!AZURE_STORAGE_CONNECTION_STRING) missing.push("AZURE_STORAGE_CONNECTION_STRING");
    if (!VISION_ENDPOINT) missing.push("AZURE_VISION_ENDPOINT");
    if (!VISION_API_KEY) missing.push("AZURE_VISION_API_KEY");

    if (missing.length > 0) {
      throw new Error("Missing env vars: " + missing.join(", "));
    }

    const result = await fetchAndProcessImage({
      pixabayKey: PIXABAY_API_KEY,
      visionEndpoint: VISION_ENDPOINT,
      visionKey: VISION_API_KEY
    });

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING
    );

    const containerClient = blobServiceClient.getContainerClient("cropped-details");

    const blobName = `detail_${Date.now()}.jpg`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(result.croppedBuffer, {
      blobHTTPHeaders: { blobContentType: "image/jpeg" }
    });

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        success: true,
        imageUrl: blockBlobClient.url
      }
    };

  } catch (err) {
    context.log.error("ERROR:", err);

    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: {
        error: err.message,
        stack: err.stack
      }
    };
  }
};