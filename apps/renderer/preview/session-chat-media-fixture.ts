/** Deterministic bitmap for exercising the media adapter without an agent/account. */
export function previewChatImage(width = 640, height = 360): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Preview canvas unavailable.");
  context.scale(width / 640, height / 360);
  context.fillStyle = "#e6f2f1";
  context.fillRect(0, 0, 640, 360);
  context.fillStyle = "#2d7774";
  context.beginPath();
  context.roundRect(248, 80, 144, 110, 24);
  context.fill();
  context.beginPath();
  context.roundRect(265, 205, 110, 95, 18);
  context.fill();
  context.lineWidth = 18;
  context.strokeStyle = "#2d7774";
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(280, 230);
  context.lineTo(220, 270);
  context.moveTo(365, 230);
  context.lineTo(418, 180);
  context.lineTo(418, 120);
  context.stroke();
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(290, 122, 10, 0, Math.PI * 2);
  context.arc(350, 122, 10, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 5;
  context.strokeStyle = "#ffffff";
  context.beginPath();
  context.arc(320, 140, 22, 0.2, Math.PI - 0.2);
  context.stroke();
  return canvas.toDataURL("image/png");
}
