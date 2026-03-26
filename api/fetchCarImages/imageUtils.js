const axios = require("axios");
const Jimp = require("jimp");

async function fetchAndProcessImage({ pixabayKey, visionEndpoint, visionKey }) {

  // 1. Hae kuva Pixabaysta
  const response = await axios.get("https://pixabay.com/api/", {
    params: {
      key: pixabayKey,
      q: "car",
      image_type: "photo",
      category: "transportation",
      per_page: 20
    }
  });

  if (!response.data.hits.length) {
    throw new Error("No images from Pixabay");
  }

  const imageUrl = response.data.hits[0].largeImageURL;

  // 2. Lataa kuva
  const imageResponse = await axios.get(imageUrl, {
    responseType: "arraybuffer"
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

  const buffer = await image.getBufferAsync(Jimp.MIME_JPEG);

  return {
    croppedBuffer: buffer
  };
}

module.exports = { fetchAndProcessImage };