import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/ooh-planning-task/',
  plugins: [react()],
})
