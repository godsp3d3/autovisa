const axios = require("axios");
const Jimp = require("jimp");

async function fetchAndProcessImage({ pixabayKey, visionEndpoint, visionKey }) {
async function fetchAndCropCarImage() {
  const pixabayKey = process.env.PIXABAY_API_KEY;

  if (!pixabayKey) {
    throw new Error("PIXABAY_API_KEY is not set");
  }

  // 1. Hae kuva Pixabaysta
  const response = await axios.get("https://pixabay.com/api/", {
    params: {
      key: pixabayKey,
      q: "car",
      image_type: "photo",
      category: "transportation",
      per_page: 20
    }
      safesearch: true,
      per_page: 50,
    },
  });

  if (!response.data.hits.length) {
    throw new Error("No images from Pixabay");
  const hits = response?.data?.hits || [];
  if (!hits.length) {
    throw new Error("No car images returned from Pixabay");
  }

  const imageUrl = response.data.hits[0].largeImageURL;
  const selectedHit = hits[Math.floor(Math.random() * hits.length)];
  const fullImageUrl = selectedHit.largeImageURL || selectedHit.webformatURL;

  if (!fullImageUrl) {
    throw new Error("Pixabay response did not include an image URL");
  }

  // 2. Lataa kuva
  const imageResponse = await axios.get(imageUrl, {
    responseType: "arraybuffer"
  const imageResponse = await axios.get(fullImageUrl, {
    responseType: "arraybuffer",
  });

  const image = await Jimp.read(imageResponse.data);

  // 3. Crop (simple center crop)
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  const cropSize = Math.min(width, height) * 0.5;

  image.crop(
    (width - cropSize) / 2,
    (height - cropSize) / 2,
    cropSize,
    cropSize
  );
  const cropSize = Math.floor(Math.min(width, height) * 0.5);
  const x = Math.floor((width - cropSize) / 2);
  const y = Math.floor((height - cropSize) / 2);

  const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);
  const cropped = image.clone().crop(x, y, cropSize, cropSize);
  const croppedBuffer = await cropped.getBufferAsync(Jimp.MIME_JPEG);

  return {
    croppedBuffer: buffer
    full_image_url: fullImageUrl,
    cropped_image_url: `data:image/jpeg;base64,${croppedBuffer.toString("base64")}`,
    source: "pixabay",
    pixabay_id: selectedHit.id,
  };
}

module.exports = { fetchAndProcessImage };
module.exports = { fetchAndCropCarImage };