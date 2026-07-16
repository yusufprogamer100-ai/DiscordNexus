const { createCanvas, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

const WIDTH = 600;
const HEIGHT = 200;

function generateBanner() {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const gradient = ctx.createLinearGradient(0, HEIGHT / 2 - 30, 0, HEIGHT / 2 + 30);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(1, '#cccccc');
  ctx.fillStyle = gradient;
  ctx.font = 'bold 64px sans-serif';
  ctx.fillText('NEXUS', WIDTH / 2, HEIGHT / 2 - 10);

  ctx.fillStyle = '#666666';
  ctx.font = '16px sans-serif';
  ctx.fillText('DISCORD BOT', WIDTH / 2, HEIGHT / 2 + 50);

  ctx.fillStyle = '#333333';
  ctx.font = '12px sans-serif';
  ctx.fillText('MODERATION \u2022 POLLS \u2022 AI \u2022 TICKETS', WIDTH / 2, HEIGHT / 2 + 75);

  const outPath = path.join(__dirname, '..', 'assets', 'banner.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(outPath, buf);
  console.log('[BANNER] Generated ->', outPath);
  return outPath;
}

module.exports = { generateBanner, WIDTH, HEIGHT };
