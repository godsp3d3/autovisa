"use strict";

const axios = require("axios");
const Jimp = require("jimp");
const { BlobServiceClient } = require("@azure/storage-blob");
const { randomUUID } = require("crypto");

// ---------- Configuration ----------
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY || "";
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING || "";
const FULL_CONTAINER = process.env.FULL_CONTAINER || "full-images";
const CROPPED_CONTAINER = process.env.CROPPED_CONTAINER || "cropped-details";

const VISION_ENDPOINT = process.env.AZURE_VISION_ENDPOINT || "";
const VISION_API_KEY = process.env.AZURE_VISION_API_KEY || "";

const MIN_CAR_AREA_RATIO = parseFloat(process.env.MIN_CAR_AREA_RATIO || "0.18");
const MAX_PERSON_TO_CAR_AREA_RATIO = parseFloat(process.env.MAX_PERSON_TO_CAR_AREA_RATIO || "1.15");
const MAX_FETCH_ATTEMPTS = parseInt(process.env.MAX_FETCH_ATTEMPTS || "12");
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT || "20") * 1000;
const CROP_PADDING = parseFloat(process.env.CROP_PADDING || "0.12");

const CAR_TAGS = new Set(["car", "truck", "bus", "motorcycle", "vehicle", "automobile", "auto"]);
const REJECT_IF_PERSON_DOMINATES =
  (process.env.REJECT_IF_DOMINATED_BY_PERSON || "true").toLowerCase() === "true";

const BRANDS = [
  "audi", "bmw", "mercedes", "volkswagen", "toyota", "honda", "ford", "chevrolet",
  "nissan", "hyundai", "kia", "mazda", "subaru", "volvo", "peugeot", "renault",
  "citroen", "fiat", "jeep", "dodge", "tesla", "porsche", "ferrari", "lamborghini",
  "maserati", "alfa romeo", "bentley", "rolls royce", "jaguar", "land rover",
  "mini", "seat", "skoda", "suzuki", "acura", "infiniti", "lexus", "genesis",
  "dacia", "hummer", "polestar", "byd", "nio", "geely", "lancia", "lucid", "rivian",
];

const ACCEPTED_PIXABAY_KEYWORDS = new Set([
  "car", "auto", "automobile", "vehicle", "cars", "transport", "sedan", "suv", "coupe",
]);

// ---------- Helpers ----------

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hasUsefulTags(tags) {
  const tagSet = new Set(tags.split(",").map((t) => t.trim().toLowerCase()));
  for (const t of tagSet) {
    if (ACCEPTED_PIXABAY_KEYWORDS.has(t)) return true;
  }
  return false;
}

function ensureConfiguration() {
  const missing = [];
  if (!PIXABAY_API_KEY) missing.push("PIXABAY_API_KEY");
  if (!AZURE_STORAGE_CONNECTION_STRING) missing.push("AZURE_STORAGE_CONNECTION_STRING");
  if (!VISION_ENDPOINT) missing.push("AZURE_VISION_ENDPOINT");
  if (!VISION_API_KEY) missing.push("AZURE_VISION_API_KEY");
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

// ---------- Pixabay ----------

async function findCandidateImage(attempt) {
  const brand = randomChoice(BRANDS);
  const page = randomInt(1, 3);
  const searchTerm = `${brand} car`;

  const response = await axios.get("https://pixabay.com/api/", {
    params: {
      key: PIXABAY_API_KEY,
      q: searchTerm,
      image_type: "photo",
      category: "transportation",
      safesearch: "true",
      orientation: "horizontal",
      per_page: 50,
      page,
      order: "popular",
    },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const hits = (response.data.hits || []).filter((h) => hasUsefulTags(h.tags || ""));
  if (!hits.length) {
    console.log(`Attempt ${attempt} for '${searchTerm}': no tag-matching hits`);
    return null;
  }

  const selected = randomChoice(hits);
  return { imageUrl: selected.largeImageURL, brand };
}

// ---------- Azure AI Vision ----------

async function detectObjectsWithVision(imageUrl, imageWidth, imageHeight) {
  const apiUrl =
    `${VISION_ENDPOINT.replace(/\/$/, "")}/computervision/imageanalysis:analyze` +
    `?api-version=2024-02-01&features=objects`;

  const response = await axios.post(
    apiUrl,
    { url: imageUrl },
    {
      headers: {
        "Ocp-Apim-Subscription-Key": VISION_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const objects = response.data?.objectsResult?.values || [];
  return objects.map((obj) => {
    const bb = obj.boundingBox; // { x, y, w, h } in pixels
    return {
      tag: (obj.tags?.[0]?.name || "").toLowerCase(),
      confidence: obj.tags?.[0]?.confidence || 0,
      boundingBox: bb,
      areaRatio: (bb.w * bb.h) / (imageWidth * imageHeight),
    };
  });
}

function selectBestVehicle(detectedObjects) {
  let bestCar = null;
  let largestPersonRatio = 0;

  for (const obj of detectedObjects) {
    if (obj.tag === "person") {
      largestPersonRatio = Math.max(largestPersonRatio, obj.areaRatio);
    }
    if (CAR_TAGS.has(obj.tag) && obj.areaRatio >= MIN_CAR_AREA_RATIO) {
      if (!bestCar || obj.areaRatio > bestCar.areaRatio) {
        bestCar = obj;
      }
    }
  }

  if (!bestCar) return null;

  if (REJECT_IF_PERSON_DOMINATES && largestPersonRatio > 0) {
    if (largestPersonRatio > bestCar.areaRatio * MAX_PERSON_TO_CAR_AREA_RATIO) {
      console.log(
        `Rejected: person dominates (person=${largestPersonRatio.toFixed(3)}, car=${bestCar.areaRatio.toFixed(3)})`
      );
      return null;
    }
  }

  return bestCar;
}

// ---------- Image crop & upload with jimp ----------

async function cropAndUpload(imageUrl, vehicle, blobServiceClient) {
  // Download image buffer
  const imgResponse = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: REQUEST_TIMEOUT_MS,
  });
  const imageBuffer = Buffer.from(imgResponse.data);

  // Read with jimp (pure JS, no native deps)
  const image = await Jimp.read(imageBuffer);
  const imgW = image.bitmap.width;
  const imgH = image.bitmap.height;

  // Build crop box with padding inset
  const { x, y, w, h } = vehicle.boundingBox;
  const padX = Math.round(w * CROP_PADDING);
  const padY = Math.round(h * CROP_PADDING);

  const cropLeft = Math.max(0, x + padX);
  const cropTop = Math.max(0, y + padY);
  const cropRight = Math.min(imgW, x + w - padX);
  const cropBottom = Math.min(imgH, y + h - padY);

  const cropWidth = Math.max(120, cropRight - cropLeft);
  const cropHeight = Math.max(120, cropBottom - cropTop);

  // Crop
  const croppedImage = image.clone().crop(cropLeft, cropTop, cropWidth, cropHeight);

  // Encode both to JPEG buffers
  const fullBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
  const croppedBuffer = await croppedImage.quality(92).getBufferAsync(Jimp.MIME_JPEG);

  // Upload
  const fullUrl = await uploadBuffer(blobServiceClient, fullBuffer, FULL_CONTAINER, "full");
  const croppedUrl = await uploadBuffer(blobServiceClient, croppedBuffer, CROPPED_CONTAINER, "crop");

  return { fullUrl, croppedUrl, imgW, imgH };
}

async function uploadBuffer(blobServiceClient, buffer, containerName, suffix) {
  const blobName = `${suffix}_${randomUUID()}.jpg`;
  const blobClient = blobServiceClient.getBlockBlobClient(containerName, blobName);
  await blobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: "image/jpeg" },
  });
  return blobClient.url;
}

// ---------- Main ----------

async function fetchAndCropCarImage() {
  ensureConfiguration();
  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    // 1. Find a candidate image URL from Pixabay
    const candidate = await findCandidateImage(attempt);
    if (!candidate) continue;

    // 2. Download image to get dimensions (needed for Vision area ratio)
    let imageBuffer, imgW, imgH;
    try {
      const imgResponse = await axios.get(candidate.imageUrl, {
        responseType: "arraybuffer",
        timeout: REQUEST_TIMEOUT_MS,
      });
      imageBuffer = Buffer.from(imgResponse.data);
      const jimpImg = await Jimp.read(imageBuffer);
      imgW = jimpImg.bitmap.width;
      imgH = jimpImg.bitmap.height;
    } catch (e) {
      console.log(`Attempt ${attempt}: image download failed — ${e.message}`);
      continue;
    }

    // 3. Detect objects with Azure AI Vision
    let detectedObjects;
    try {
      detectedObjects = await detectObjectsWithVision(candidate.imageUrl, imgW, imgH);
    } catch (e) {
      console.log(`Attempt ${attempt}: Vision API error — ${e.message}`);
      continue;
    }

    // 4. Select best vehicle
    const vehicle = selectBestVehicle(detectedObjects);
    if (!vehicle) {
      console.log(`Attempt ${attempt}: no acceptable vehicle detected`);
      continue;
    }

    // 5. Crop & upload
    const { fullUrl, croppedUrl } = await cropAndUpload(
      candidate.imageUrl,
      vehicle,
      blobServiceClient
    );

    return {
      full_image_url: fullUrl,
      cropped_image_url: croppedUrl,
      source: "pixabay",
      brand_query: candidate.brand,
      detected_label: vehicle.tag,
      confidence: Math.round(vehicle.confidence * 10000) / 10000,
      car_area_ratio: Math.round(vehicle.areaRatio * 10000) / 10000,
    };
  }

  return {
    error: "No suitable car image found after validation.",
    attempts: MAX_FETCH_ATTEMPTS,
  };
}

module.exports = { fetchAndCropCarImage };
