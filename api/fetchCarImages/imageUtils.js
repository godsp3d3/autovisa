"use strict";

const axios = require("axios");
const Jimp = require("jimp");
const { BlobServiceClient } = require("@azure/storage-blob");
const { randomUUID } = require("crypto");

const FULL_CONTAINER = "full-images";
const CROPPED_CONTAINER = "cropped-details";

const MAX_FETCH_ATTEMPTS = 16;
const OCR_POLL_ATTEMPTS = 12;
const OCR_POLL_DELAY_MS = 650;
const TEXT_BLUR_RADIUS = 12;
const PIXABAY_PER_PAGE = 50;
const PIXABAY_MAX_PAGE = 10;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function uploadBuffer(blobServiceClient, buffer, containerName, prefix) {
  const blobName = `${prefix}_${randomUUID()}.jpg`;

  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists({ access: "blob" });

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

  const url = `${endpoint}/vision/v3.2/analyze?visualFeatures=Objects,Tags&language=en`;

  const response = await axios.post(url, imageBuffer, {
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/octet-stream"
    },
    timeout: 20000
  });

  return response.data;
}

async function readTextWithVision(imageBuffer) {
  const endpoint = normalizeEndpoint(process.env.AZURE_VISION_ENDPOINT);
  const key = process.env.AZURE_VISION_API_KEY;
  const analyzeUrl = `${endpoint}/vision/v3.2/read/analyze?language=en`;

  const submitResponse = await axios.post(analyzeUrl, imageBuffer, {
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/octet-stream"
    },
    timeout: 20000,
    validateStatus: status => status >= 200 && status < 300
  });

  const operationLocation = submitResponse.headers["operation-location"];
  if (!operationLocation) {
    throw new Error("Azure Vision OCR did not return Operation-Location.");
  }

  for (let i = 0; i < OCR_POLL_ATTEMPTS; i++) {
    await sleep(OCR_POLL_DELAY_MS);

    const resultResponse = await axios.get(operationLocation, {
      headers: { "Ocp-Apim-Subscription-Key": key },
      timeout: 20000
    });

    const status = resultResponse.data.status;

    if (status === "succeeded") {
      return resultResponse.data.analyzeResult || {};
    }

    if (status === "failed") {
      throw new Error("Azure Vision OCR failed.");
    }
  }

  throw new Error("Azure Vision OCR timed out.");
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

function boundingBoxToRect(boundingBox, imageWidth, imageHeight) {
  if (!Array.isArray(boundingBox) || boundingBox.length < 8) return null;

  const xs = [boundingBox[0], boundingBox[2], boundingBox[4], boundingBox[6]];
  const ys = [boundingBox[1], boundingBox[3], boundingBox[5], boundingBox[7]];

  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(imageWidth, Math.ceil(Math.max(...xs)));
  const maxY = Math.min(imageHeight, Math.ceil(Math.max(...ys)));

  const w = maxX - minX;
  const h = maxY - minY;

  if (w <= 0 || h <= 0) return null;

  const padX = Math.max(10, Math.floor(w * 0.35));
  const padY = Math.max(8, Math.floor(h * 0.55));

  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);
  const paddedW = Math.min(imageWidth - x, w + padX * 2);
  const paddedH = Math.min(imageHeight - y, h + padY * 2);

  return { x, y, w: paddedW, h: paddedH };
}

function collectOcrBlurRegions(ocrResult, imageWidth, imageHeight) {
  const regions = [];
  const pages = ocrResult.readResults || [];

  for (const page of pages) {
    const lines = page.lines || [];

    for (const line of lines) {
      const rect = boundingBoxToRect(line.boundingBox, imageWidth, imageHeight);
      if (rect) regions.push(rect);
    }
  }

  return regions;
}

function blurRegions(image, regions) {
  const target = image.clone();

  for (const region of regions) {
    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));
    const w = Math.min(target.bitmap.width - x, Math.floor(region.w));
    const h = Math.min(target.bitmap.height - y, Math.floor(region.h));

    if (w < 4 || h < 4) continue;

    const patch = target.clone().crop(x, y, w, h).blur(TEXT_BLUR_RADIUS);
    target.composite(patch, x, y);
  }

  return target;
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
  const page = randomInt(1, PIXABAY_MAX_PAGE);

  const response = await axios.get("https://pixabay.com/api/", {
    params: {
      key: process.env.PIXABAY_API_KEY,
      q: "car automobile vehicle classic car sports car",
      category: "transportation",
      image_type: "photo",
      safesearch: "true",
      orientation: "horizontal",
      per_page: PIXABAY_PER_PAGE,
      page
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

async function applyOcrBlurToCroppedImage(croppedImage) {
  let regions = [];
  let blurredImage = croppedImage.clone();

  try {
    const preOcrBuffer = await croppedImage.clone().quality(90).getBufferAsync(Jimp.MIME_JPEG);
    const ocrResult = await readTextWithVision(preOcrBuffer);
    regions = collectOcrBlurRegions(
      ocrResult,
      croppedImage.bitmap.width,
      croppedImage.bitmap.height
    );
    blurredImage = blurRegions(croppedImage, regions);
  } catch (ocrErr) {
    console.log("OCR blur skipped:", ocrErr.message);
  }

  return {
    image: blurredImage,
    regions
  };
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

      if (width < 600 || height < 400) continue;

      const visionResult = await analyzeImageWithVision(originalBuffer);
      const bestVehicle = findBestVehicleObject(visionResult, width, height);
      const hasVehicleTag = tagsContainVehicle(visionResult);

      if (!bestVehicle && !hasVehicleTag) continue;

      // Full image is intentionally not blurred in v3. Only the quiz/cropped image is sanitized.
      const fullBuffer = await image.clone().quality(88).getBufferAsync(Jimp.MIME_JPEG);

      const rawCroppedImage = bestVehicle
        ? cropAroundRectangle(image, bestVehicle.rectangle)
        : centerCrop(image);

      const blurredCrop = await applyOcrBlurToCroppedImage(rawCroppedImage);

      const croppedBuffer = await blurredCrop.image
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
        ocr_blur_regions: blurredCrop.regions.length,
        attempts_used: i + 1,
        autovisa_version: "v3-cropped-ocr-blur"
      };
    } catch (err) {
      console.log("Skipping image candidate:", err.message);
      continue;
    }
  }

  return {
    error: "No suitable car image found after validation.",
    attempts
  };
}

module.exports = {
  fetchAndCropCarImage
};
