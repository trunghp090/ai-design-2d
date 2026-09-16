// Keep the reference editor isolated from legacy tab styles and DOM IDs.
window.initCholyStudio = function () {
  const root = document.getElementById('view-choly');
  if (root.querySelector('iframe')) return;
  const frame = document.createElement('iframe');
  frame.src = '/reference-studio.html';
  frame.title = 'Tạo ảnh từ tham chiếu';
  frame.style.cssText = 'display:block;width:100%;height:calc(100vh - 175px);min-height:700px;border:0;border-radius:12px;background:#101211';
  root.appendChild(frame);
};
