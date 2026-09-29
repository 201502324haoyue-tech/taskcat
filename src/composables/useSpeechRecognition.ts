/**
 * Web Speech API 语音识别封装（专用手机端）。
 * Android WebView（Chrome）支持 webkitSpeechRecognition，可在 Capacitor 应用内使用。
 */
import { ref } from 'vue'

export function useSpeechRecognition() {
  const supported = ref(false)
  const listening = ref(false)
  const interimText = ref('')
  const finalText = ref('')
  const error = ref('')

  let recognition: SpeechRecognition | null = null

  // 检测支持性
  const SpeechRecognitionCtor =
    (window as unknown as { SpeechRecognition: new () => SpeechRecognition }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition: new () => SpeechRecognition }).webkitSpeechRecognition

  if (SpeechRecognitionCtor) {
    supported.value = true
  }

  function start(): void {
    if (!SpeechRecognitionCtor) {
      error.value = '本设备不支持语音识别'
      return
    }
    if (listening.value) return
    error.value = ''
    interimText.value = ''
    finalText.value = ''

    const r = new SpeechRecognitionCtor()
    r.lang = 'zh-CN'
    r.continuous = true
    r.interimResults = true

    r.onresult = (event: SpeechRecognitionEvent) => {
      let final = ''
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          final += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }
      if (final) finalText.value += final
      interimText.value = interim
    }

    r.onerror = (event: SpeechRecognitionErrorEvent) => {
      error.value = event.error === 'not-allowed' ? '录音权限被拒绝' : `语音识别错误：${event.error}`
      listening.value = false
    }

    r.onend = () => {
      listening.value = false
    }

    try {
      r.start()
      listening.value = true
      recognition = r
    } catch (e) {
      error.value = `启动语音识别失败：${e instanceof Error ? e.message : String(e)}`
    }
  }

  function stop(): void {
    if (recognition && listening.value) {
      recognition.stop()
    }
    listening.value = false
  }

  /** 获取最终识别的完整文本 */
  function getResult(): string {
    const result = (finalText.value + interimText.value).trim()
    stop()
    return result
  }

  return {
    supported,
    listening,
    interimText,
    finalText,
    error,
    start,
    stop,
    getResult,
  }
}