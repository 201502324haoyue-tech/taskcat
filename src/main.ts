import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { isTauri } from './utils/tauri'
import './styles/main.css'

// Tauri 桌面：body 背景设为完全透明，避免窗口内出现方形底板（见 main.css .tauri）
if (isTauri()) {
  document.documentElement.classList.add('tauri')
}

createApp(App).use(createPinia()).mount('#app')
