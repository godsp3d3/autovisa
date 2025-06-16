let images = [];
let currentIndex = 0;

document.getElementById("startBtn").onclick = async () => {
  const res = await fetch("/api/generate");
  images = await res.json();
  currentIndex = 0;
  showImage();
  document.getElementById("nextBtn").disabled = false;
  document.getElementById("showAnswersBtn").disabled = false;
};

document.getElementById("nextBtn").onclick = () => {
  currentIndex = (currentIndex + 1) % images.length;
  showImage();
};

document.getElementById("showAnswersBtn").onclick = () => {
  const img = images[currentIndex];
  document.getElementById("questionContainer").innerHTML =
    `<img src="${img.full_url}" /><p>Oikea kuva (täysi versio)</p>`;
};

function showImage() {
  const img = images[currentIndex];
  document.getElementById("questionContainer").innerHTML =
    `<img src="${img.url}" /><p>Kysymys ${currentIndex + 1}/20</p>`;
}
