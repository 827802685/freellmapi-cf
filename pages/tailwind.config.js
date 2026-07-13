/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: { primary: '#0a0a0f', secondary: '#12121a', tertiary: '#1a1a24' },
        border: { subtle: '#1f1f2e', strong: '#2a2a3d' },
        text: { primary: '#e5e5e7', secondary: '#a0a0aa', muted: '#6b6b78' },
        accent: { primary: '#7c3aed', hover: '#6d28d9' },
        success: '#10b981',
        warning: '#f59e0b',
        danger: '#ef4444',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
