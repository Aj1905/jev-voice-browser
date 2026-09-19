// サイドパネルからは許可ダイアログを出せないので、通常のタブで一度だけ許可を取る
navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
  stream.getTracks().forEach((t) => t.stop());
  document.getElementById('msg').textContent = '許可されました。このタブを閉じて、サイドパネルのマイクボタンをもう一度押してください。';
}).catch((e) => {
  document.getElementById('msg').textContent =
    `許可されませんでした (${e.name})。アドレスバー左のアイコンからマイクを「許可」に変えて、このページを再読み込みしてください。`;
});
