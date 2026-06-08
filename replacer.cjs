const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');
const reps = [
  ['bg-[#0d0e10]', 'bg-app'],
  ['bg-[#151619]', 'bg-panel'],
  ['bg-[#101010]', 'bg-qso'],
  ['bg-[#1c1e23]', 'bg-header'],
  ['bg-[#23252a]', 'bg-btn'],
  ['hover:bg-[#23252a]', 'hover:bg-btn'],
  ['bg-[#2a2c33]', 'bg-btn-hover'],
  ['hover:bg-[#2a2c33]', 'hover:bg-btn-hover'],
  ['border-[#2a2c31]', 'border-border-subtle'],
  ['border-[#3a3d45]', 'border-border-input'],
  ['text-[#e0e0e0]', 'text-text-main'],
  ['text-[#8e9299]', 'text-text-muted'],
  ['text-[#4caf50]', 'text-green-600 dark:text-[#4caf50]'],
  ['bg-[#4caf50]', 'bg-green-600 dark:bg-[#4caf50]'],
  ['bg-[#050505]', 'bg-white dark:bg-[#050505]'],
  ['text-white', 'text-text-highlight'],
];
for(let [a,b] of reps) {
  code = code.split(a).join(b);
}
fs.writeFileSync('src/App.tsx', code);
