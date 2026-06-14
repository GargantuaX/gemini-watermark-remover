/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './public/**/*.html',
    './src/**/*.js',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#10B981',
        'primary-hover': '#059669',
        dark: '#1F2937',
        success: '#10B981',
        warn: '#F59E0B',
        err: '#EF4444',
        info: '#3B82F6',
      },
      boxShadow: {
        'soft': '0 4px 20px -2px rgba(16, 185, 129, 0.1)',
        'card': '0 0 20px rgba(0,0,0,0.05)',
      },
    },
  },
  plugins: [],
};
