"use strict";

const axios = require("axios");
const Jimp = require("jimp");
const { BlobServiceClient } = require("@azure/storage-blob");
const { randomUUID } = require("crypto");

const FULL_CONTAINER = "full-images";
const CROPPED_CONTAINER = "cropped-details";

const MAX_FETCH_ATTEMPTS = 30;
const OCR_POLL_ATTEMPTS = 12;
const OCR_POLL_DELAY_MS = 650;
const TEXT_BLUR_RADIUS = 12;

const PIXABAY_PER_PAGE = 50;
const PIXABAY_MAX_PAGE = 20;
const PEXELS_PER_PAGE = 40;
const PEXELS_MAX_PAGE = 20;
const UNSPLASH_PER_PAGE = 30;
const UNSPLASH_MAX_PAGE = 20;

const SEARCH_TERMS = [
  "classic car",
  "sports car",
  "vintage car",
  "car",
  "sedan",
  "coupe",
  "hatchback",
  "SUV",
  "muscle car"
];

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

function randomItem(items) {
  return items[randomInt(0, items.length - 1)];
}

function normalizeId(id) {
  return id === undefined || id === null ? "" : String(id).trim();
}

function makeGlobalId(source, id) {
  return `${source}:${normalizeId(id)}`;
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

function normalizePixabay(hit) {
  const id = normalizeId(hit.id);
  if (!id) return null;

  return {
    source: "pixabay",
    id,
    globalId: makeGlobalId("pixabay", id),
    imageUrl: hit.largeImageURL || hit.webformatURL,
    pageUrl: hit.pageURL || "",
    tags: hit.tags || ""
  };
}

function normalizePexels(photo) {
  const id = normalizeId(photo.id);
  if (!id || !photo.src) return null;

  return {
    source: "pexels",
    id,
    globalId: makeGlobalId("pexels", id),
    imageUrl: photo.src.large2x || photo.src.large || photo.src.original,
    pageUrl: photo.url || "",
    tags: photo.alt || ""
  };
}

function normalizeUnsplash(photo) {
  const id = normalizeId(photo.id);
  if (!id || !photo.urls) return null;

  const tags = [
    photo.alt_description,
    photo.description,
    Array.isArray(photo.tags) ? photo.tags.map(tag => tag.title).join(", ") : ""
  ].filter(Boolean).join(", ");

  return {
    source: "unsplash",
    id,
    globalId: makeGlobalId("unsplash", id),
    imageUrl: photo.urls.regular || photo.urls.full || photo.urls.raw,
    pageUrl: photo.links && photo.links.html ? photo.links.html : "",
    downloadLocation: photo.links && photo.links.download_location ? photo.links.download_location : "",
    tags
  };
}

async function fetchPixabayCandidates() {
  if (!process.env.PIXABAY_API_KEY) return [];

  const pages = new Set();
  while (pages.size < 2) pages.add(randomInt(1, PIXABAY_MAX_PAGE));

  const results = await Promise.allSettled(
    Array.from(pages).map(page => axios.get("https://pixabay.com/api/", {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: randomItem(SEARCH_TERMS),
        category: "transportation",
        image_type: "photo",
        safesearch: "true",
        orientation: "horizontal",
        per_page: PIXABAY_PER_PAGE,
        page
      },
      timeout: 20000
    }))
  );

  const candidates = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const hits = result.value.data && Array.isArray(result.value.data.hits) ? result.value.data.hits : [];
    for (const hit of hits) {
      const normalized = normalizePixabay(hit);
      if (normalized && normalized.imageUrl) candidates.push(normalized);
    }
  }

  return candidates;
}

async function fetchPexelsCandidates() {
  if (!process.env.PEXELS_API_KEY) return [];

  const queries = [randomItem(SEARCH_TERMS), randomItem(SEARCH_TERMS)];

  const results = await Promise.allSettled(
    queries.map(query => axios.get("https://api.pexels.com/v1/search", {
      params: {
        query,
        orientation: "landscape",
        size: "large",
        per_page: PEXELS_PER_PAGE,
        page: randomInt(1, PEXELS_MAX_PAGE)
      },
      headers: {
        Authorization: process.env.PEXELS_API_KEY
      },
      timeout: 20000
    }))
  );

  const candidates = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const photos = result.value.data && Array.isArray(result.value.data.photos) ? result.value.data.photos : [];
    for (const photo of photos) {
      const normalized = normalizePexels(photo);
      if (normalized && normalized.imageUrl) candidates.push(normalized);
    }
  }

  return candidates;
}

async function triggerUnsplashDownload(candidate) {
  if (!candidate.downloadLocation || !process.env.UNSPLASH_ACCESS_KEY) return;

  try {
    await axios.get(candidate.downloadLocation, {
      params: { client_id: process.env.UNSPLASH_ACCESS_KEY },
      timeout: 10000
    });
  } catch (err) {
    console.log("Unsplash download tracking skipped:", err.message);
  }
}

async function fetchUnsplashCandidates() {
  if (!process.env.UNSPLASH_ACCESS_KEY) return [];

  const queries = [randomItem(SEARCH_TERMS), randomItem(SEARCH_TERMS), randomItem(SEARCH_TERMS)];

  const results = await Promise.allSettled(
    queries.map(query => axios.get("https://api.unsplash.com/search/photos", {
      params: {
        query,
        orientation: "landscape",
        content_filter: "high",
        per_page: UNSPLASH_PER_PAGE,
        page: randomInt(1, UNSPLASH_MAX_PAGE)
      },
      headers: {
        Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
        "Accept-Version": "v1"
      },
      timeout: 20000
    }))
  );

  const candidates = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const photos = result.value.data && Array.isArray(result.value.data.results) ? result.value.data.results : [];
    for (const photo of photos) {
      const normalized = normalizeUnsplash(photo);
      if (normalized && normalized.imageUrl) candidates.push(normalized);
    }
  }

  return candidates;
}

async function fetchImageCandidates(excludeSet) {
  const results = await Promise.allSettled([
    fetchUnsplashCandidates(),
    fetchPexelsCandidates(),
    fetchPixabayCandidates()
  ]);

  const seen = new Set();
  const candidates = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;

    for (const candidate of result.value) {
      if (!candidate || !candidate.globalId || !candidate.imageUrl) continue;
      if (excludeSet.has(candidate.globalId)) continue;
      if (seen.has(candidate.globalId)) continue;

      seen.add(candidate.globalId);
      candidates.push(candidate);
    }
  }

  // Light weighting: Unsplash candidates are already fetched in larger numbers,
  // so simple shuffle keeps it roughly Unsplash-heavy while still mixing sources.
  return candidates.sort(() => Math.random() - 0.5);
}

async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent": "Autovisa/3.5"
    }
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

async function fetchAndCropCarImage(options = {}) {
  const excludeSet = new Set((options.excludeIds || []).map(normalizeId).filter(Boolean));

  const required = [
    "AZURE_STORAGE_CONNECTION_STRING",
    "AZURE_VISION_ENDPOINT",
    "AZURE_VISION_API_KEY"
  ];

  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new Error("Missing environment variables: " + missing.join(", "));
  }

  if (!process.env.UNSPLASH_ACCESS_KEY && !process.env.PEXELS_API_KEY && !process.env.PIXABAY_API_KEY) {
    throw new Error("At least one image API key is required: UNSPLASH_ACCESS_KEY, PEXELS_API_KEY or PIXABAY_API_KEY.");
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING
  );

  const candidates = await fetchImageCandidates(excludeSet);

  if (candidates.length === 0) {
    throw new Error("No new images found after duplicate filtering.");
  }

  const attempts = Math.min(MAX_FETCH_ATTEMPTS, candidates.length);

  for (let i = 0; i < attempts; i++) {
    const candidate = candidates[i];

    if (!candidate.imageUrl || !candidate.globalId || excludeSet.has(candidate.globalId)) continue;

    try {
      const originalBuffer = await downloadImage(candidate.imageUrl);
      const image = await Jimp.read(originalBuffer);
      const width = image.bitmap.width;
      const height = image.bitmap.height;

      if (width < 600 || height < 400) continue;

      const visionResult = await analyzeImageWithVision(originalBuffer);
      const bestVehicle = findBestVehicleObject(visionResult, width, height);
      const hasVehicleTag = tagsContainVehicle(visionResult);

      if (!bestVehicle && !hasVehicleTag) continue;

      if (candidate.source === "unsplash") {
        await triggerUnsplashDownload(candidate);
      }

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
        source_image_url: candidate.imageUrl,
        source_page_url: candidate.pageUrl,
        image_source: candidate.source,
        image_id: candidate.id,
        pixabay_id: candidate.globalId,
        tags: candidate.tags || "",
        detected_object: bestVehicle ? bestVehicle.object : null,
        ocr_blur_regions: blurredCrop.regions.length,
        attempts_used: i + 1,
        excluded_count: excludeSet.size,
        candidate_count: candidates.length,
        autovisa_version: "v3.5-hybrid-sources"
      };
    } catch (err) {
      console.log(`Skipping ${candidate.source}:${candidate.id}:`, err.message);
      continue;
    }
  }

  return {
    error: "No suitable new car image found after validation.",
    attempts,
    excluded_count: excludeSet.size,
    candidate_count: candidates.length
  };
}

module.exports = {
  fetchAndCropCarImage
};
