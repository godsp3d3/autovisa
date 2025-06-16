const STORAGE_URL = "https://autovisa.blob.core.windows.net/images";

let quizData = [];
let currentIndex = 0;

const generateBtn = document.getElementById('generateBtn');
const startBtn = document.getElementById('startBtn');
const quizArea = document.getElementById('quizArea');
const answers = document.getElementById('answers');
const answerList = document.getElementById('answerList');

generateBtn.onclick = () => {
  fetch('/api/generate')
    .then(res => res.json())
    .then(data => {
      alert(`Uusi visa luotu (${data.questions} kysymystä)!`);
      location.reload();
    })
    .catch(err => alert("Virhe visan luonnissa: " + err));
};

startBtn.onclick = () => {
  startBtn.style.display = 'none';
  showNextQuestion();
};

function showNextQuestion() {
  quizArea.innerHTML = '';
  answers.style.display = 'none';
  quizArea.style.display = 'block';

  if (currentIndex < quizData.length) {
    const q = quizData[currentIndex];
    const img = document.createElement('img');
    img.src = `${STORAGE_URL}/${q.small}`;
    quizArea.appendChild(img);

    const btn = document.createElement('button');
    btn.innerText = "Seuraava kysymys";
    btn.onclick = () => {
      currentIndex++;
      showNextQuestion();
    };
    quizArea.appendChild(btn);
  } else {
    showAnswers();
  }
}

function showAnswers() {
  quizArea.style.display = 'none';
  answers.style.display = 'block';
  answerList.innerHTML = '';
  quizData.forEach(q => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${q.answer}</strong><br><img src="${STORAGE_URL}/${q.large}" alt="">`;
    answerList.appendChild(li);
  });
}

fetch(`${STORAGE_URL}/data.json`)
  .then(res => res.json())
  .then(data => {
    quizData = data;
    startBtn.style.display = 'inline-block';
  });
