"use strict";

const axios = require("axios");
const Jimp = require("jimp");
const { BlobServiceClient } = require("@azure/storage-blob");
const { randomUUID } = require("crypto");

const FULL_CONTAINER = "full-images";
const CROPPED_CONTAINER = "cropped-details";

const MAX_FETCH_ATTEMPTS = 12;

const VEHICLE_WORDS = [
  "car",
  "auto",
  "automobile",
  "vehicle",
  "sports car",
  "classic car",
  "sedan",
  "coupe",
  "convertible",
  "truck",
  "bus",
  "van"
];

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, "");
}

async function uploadBuffer(blobServiceClient, buffer, containerName, prefix) {
  const blobName = `${prefix}_${randomUUID()}.jpg`;

  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists({
    access: "blob"
  });

  const blobClient = containerClient.getBlockBlobClient(blobName);

  await blobClient.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: "image/jpeg",
      blobCacheControl: "public, max-age=31536000"
    }
  });

  return blobClient.url;
}

function isVehicleName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return VEHICLE_WORDS.some(word => lower.includes(word));
}

async function analyzeImageWithVision(imageBuffer) {
  const endpoint = normalizeEndpoint(process.env.AZURE_VISION_ENDPOINT);
  const key = process.env.AZURE_VISION_API_KEY;

  const url =
    `${endpoint}/vision/v3.2/analyze` +
    `?visualFeatures=Objects,Tags&language=en`;

  const response = await axios.post(url, imageBuffer, {
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/octet-stream"
    },
    timeout: 20000
  });

  return response.data;
}

function findBestVehicleObject(visionResult, imageWidth, imageHeight) {
  const objects = visionResult.objects || [];

  let best = null;
  let bestArea = 0;

  for (const obj of objects) {
    if (!isVehicleName(obj.object)) continue;
    if (!obj.rectangle) continue;

    const rect = obj.rectangle;
    const area = rect.w * rect.h;
    const areaRatio = area / (imageWidth * imageHeight);

    if (areaRatio < 0.05) continue;

    if (area > bestArea) {
      best = obj;
      bestArea = area;
    }
  }

  return best;
}

function tagsContainVehicle(visionResult) {
  const tags = visionResult.tags || [];

  return tags.some(tag => {
    const name = tag.name || "";
    const confidence = tag.confidence || 0;
    return confidence >= 0.55 && isVehicleName(name);
  });
}

function cropAroundRectangle(image, rect) {
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  const padding = 0.25;

  let x = Math.max(0, Math.floor(rect.x - rect.w * padding));
  let y = Math.max(0, Math.floor(rect.y - rect.h * padding));
  let w = Math.min(width - x, Math.floor(rect.w * (1 + padding * 2)));
  let h = Math.min(height - y, Math.floor(rect.h * (1 + padding * 2)));

  const size = Math.min(w, h);

  x = Math.max(0, Math.floor(x + (w - size) / 2));
  y = Math.max(0, Math.floor(y + (h - size) / 2));

  return image.clone().crop(x, y, size, size).resize(700, 700);
}

function centerCrop(image) {
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const size = Math.floor(Math.min(width, height) * 0.55);

  const x = Math.floor((width - size) / 2);
  const y = Math.floor((height - size) / 2);

  return image.clone().crop(x, y, size, size).resize(700, 700);
}

async function fetchPixabayCandidates() {
  const response = await axios.get("https://pixabay.com/api/", {
    params: {
      key: process.env.PIXABAY_API_KEY,
      q: "car automobile vehicle",
      category: "transportation",
      image_type: "photo",
      safesearch: "true",
      orientation: "horizontal",
      per_page: 50
    },
    timeout: 20000
  });

  if (!response.data || !Array.isArray(response.data.hits)) {
    throw new Error("Pixabay response was invalid.");
  }

  return response.data.hits;
}

async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000
  });

  return Buffer.from(response.data);
}

async function fetchAndCropCarImage() {
  const required = [
    "PIXABAY_API_KEY",
    "AZURE_STORAGE_CONNECTION_STRING",
    "AZURE_VISION_ENDPOINT",
    "AZURE_VISION_API_KEY"
  ];

  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new Error("Missing environment variables: " + missing.join(", "));
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING
  );

  const candidates = await fetchPixabayCandidates();

  if (candidates.length === 0) {
    throw new Error("No Pixabay images found.");
  }

  const shuffled = candidates.sort(() => Math.random() - 0.5);
  const attempts = Math.min(MAX_FETCH_ATTEMPTS, shuffled.length);

  for (let i = 0; i < attempts; i++) {
    const candidate = shuffled[i];
    const sourceUrl = candidate.largeImageURL || candidate.webformatURL;

    if (!sourceUrl) continue;

    try {
      const originalBuffer = await downloadImage(sourceUrl);
      const image = await Jimp.read(originalBuffer);

      const width = image.bitmap.width;
      const height = image.bitmap.height;

      if (width < 600 || height < 400) {
        continue;
      }

      const visionResult = await analyzeImageWithVision(originalBuffer);

      const bestVehicle = findBestVehicleObject(
        visionResult,
        width,
        height
      );

      const hasVehicleTag = tagsContainVehicle(visionResult);

      if (!bestVehicle && !hasVehicleTag) {
        continue;
      }

      const fullImage = image.clone().quality(88);
      const fullBuffer = await fullImage.getBufferAsync(Jimp.MIME_JPEG);

      const croppedImage = bestVehicle
        ? cropAroundRectangle(image, bestVehicle.rectangle)
        : centerCrop(image);

      const croppedBuffer = await croppedImage
        .quality(90)
        .getBufferAsync(Jimp.MIME_JPEG);

      const fullImageUrl = await uploadBuffer(
        blobServiceClient,
        fullBuffer,
        FULL_CONTAINER,
        "full"
      );

      const croppedImageUrl = await uploadBuffer(
        blobServiceClient,
        croppedBuffer,
        CROPPED_CONTAINER,
        "detail"
      );

      return {
        cropped_image_url: croppedImageUrl,
        full_image_url: fullImageUrl,
        source_image_url: sourceUrl,
        pixabay_id: candidate.id,
        tags: candidate.tags || "",
        detected_object: bestVehicle ? bestVehicle.object : null,
        attempts_used: i + 1
      };
    } catch (err) {
      console.log("Skipping image candidate:", err.message);
      continue;
    }
  }

  return {
    error: "No suitable car image found after validation.",
    attempts: attempts
  };
}

module.exports = {
  fetchAndCropCarImage
};