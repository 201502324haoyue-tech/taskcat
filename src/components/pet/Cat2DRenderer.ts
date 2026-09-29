import type { PetMood } from '@/utils/petState'
import type { PetRenderer } from './PetRenderer'

/**
 * 程序化 2D 小猫（V1 占位美术，Spec §6.4）。
 * - 4 个情绪行为：active（跑跳/zoomies）、wander（闲逛/伸懒腰）、relaxed（眨眼/舔毛/打哈欠）、sleep（蜷睡 + Z 粒子）
 * - 参数用指数平滑过渡，状态切换无跳变
 * - 眼神/头部跟随鼠标、点击惊吓动画
 *
 * 设计坐标系：140 × 120，地面 y=104；绘制时按容器等比缩放居中。
 */

const DESIGN_W = 140
// 设计高度 96（原 120）：裁掉猫上方的大量留白，让猫充满画布
const DESIGN_H = 96
const GROUND_Y = 84

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  text: string
  size: number
}

interface Pose {
  x: number
  y: number
  bodyRx: number
  bodyRy: number
  lean: number
  sx: number
  headX: number
  headY: number
  headA: number
  earFlat: number
  eyeOpen: number
  pupilX: number
  pupilY: number
  eyeWide: number
  mouth: number
  pawLift: number
  stretch: number
  curl: number
  tailA: number
  tailTip: number
  tailWave: number
  walkPhase: number
  walkAmt: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function lerp(cur: number, target: number, k: number): number {
  return cur + (target - cur) * k
}

function makePose(): Pose {
  return {
    x: 70, y: 68, bodyRx: 24, bodyRy: 17, lean: 0, sx: 1,
    headX: 0, headY: -26, headA: 0,
    earFlat: 0, eyeOpen: 1, pupilX: 0, pupilY: 0, eyeWide: 0,
    mouth: 0, pawLift: 0, stretch: 0, curl: 0,
    tailA: 0.55, tailTip: 0.35, tailWave: 0,
    walkPhase: 0, walkAmt: 0,
  }
}

export class Cat2DRenderer implements PetRenderer {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  private last = 0
  private t = 0

  private mood: PetMood = 'relaxed'
  private pose = makePose()
  private target = makePose()
  private pointer: { x: number; y: number } | null = null

  private startleAt = -1
  private startleDuration = 1.0
  private particles: Particle[] = []

  private blinkAt = 1.5
  private groomAt = 6
  private groomUntil = -1
  private yawnAt = 11
  private yawnUntil = -1
  private walkDir = 1
  private pauseUntil = 0
  private stretchAt = 0
  private stretchUntil = -1
  private jumpAt = 1
  private jumpUntil = -1
  private zoomieAt = 7
  private zoomieUntil = -1
  private zoomieFlipAt = 0
  private zAt = 0.8

  private rng = mulberry32(20260811)
  private destroyed = false

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    this.ctx = ctx
    this.resize()
    this.last = performance.now()
    const loop = (now: number) => {
      if (this.destroyed) return
      const dt = clamp((now - this.last) / 1000, 0, 0.05)
      this.last = now
      this.t += dt
      this.step(dt)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  resize(): void {
    if (!this.canvas || !this.ctx) return
    const cssW = this.canvas.clientWidth || 100
    const cssH = this.canvas.clientHeight || 100
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  setMood(mood: PetMood): void {
    if (this.mood === mood) return
    this.mood = mood
    // 切换状态时重置该行为的随机计时
    this.resetBehaviorTimers()
  }

  startle(): void {
    this.startleAt = this.t
  }

  setPointer(x: number, y: number): void {
    this.pointer = { x, y }
  }

  clearPointer(): void {
    this.pointer = null
  }

  destroy(): void {
    this.destroyed = true
    cancelAnimationFrame(this.raf)
    this.canvas = null
    this.ctx = null
  }

  // ---------------------------------------------------------------- 行为

  private resetBehaviorTimers(): void {
    const r = this.rng
    switch (this.mood) {
      case 'relaxed':
        this.blinkAt = this.t + 1 + r() * 3
        this.groomAt = this.t + 4 + r() * 8
        this.groomUntil = -1
        this.yawnAt = this.t + 10 + r() * 12
        this.yawnUntil = -1
        break
      case 'wander':
        this.pauseUntil = this.t + 0.5
        this.stretchUntil = -1
        break
      case 'active':
        this.jumpAt = this.t + 0.8 + r() * 2.2
        this.jumpUntil = -1
        this.zoomieAt = this.t + 5 + r() * 8
        this.zoomieUntil = -1
        break
      case 'sleep':
        this.zAt = this.t + 0.5
        break
    }
  }

  private behaveRelaxed(): void {
    const T = this.target
    T.x = 70; T.y = 68; T.bodyRx = 24; T.bodyRy = 17; T.lean = 0; T.sx = 1
    T.headX = 0; T.headY = -26
    T.earFlat = 0; T.eyeWide = 0; T.mouth = 0; T.stretch = 0; T.curl = 0
    T.walkPhase = 0; T.walkAmt = 0; T.pawLift = 0
    T.tailA = 0.55 + Math.sin(this.t * 1.1) * 0.06
    T.tailTip = 0.35 + Math.sin(this.t * 0.7) * 0.1
    T.tailWave = this.t * 2
    T.bodyRy = 17 + Math.sin(this.t * 1.6) * 0.5

    // 眨眼
    if (this.t > this.blinkAt) {
      T.eyeOpen = 0.1
      this.blinkAt = this.t + 2.5 + this.rng() * 4
    } else {
      T.eyeOpen = 1
    }
    // 舔毛
    if (this.t < this.groomUntil) {
      T.pawLift = 1
      T.headA = -0.2
      T.headY = -27
    } else if (this.t > this.groomAt) {
      this.groomUntil = this.t + 2.2
      this.groomAt = this.t + 9 + this.rng() * 8
    }
    // 打哈欠
    if (this.t < this.yawnUntil) {
      T.mouth = 1
      T.eyeOpen = 0.5
    } else if (this.t > this.yawnAt) {
      this.yawnUntil = this.t + 1.6
      this.yawnAt = this.t + 14 + this.rng() * 12
    }
    T.headA += Math.sin(this.t * 0.5) * 0.05
  }

  private behaveWander(): void {
    const T = this.target
    const r = this.rng
    const dir = this.walkDir

    if (this.t < this.pauseUntil) {
      // 停下东张西望 / 偶尔伸懒腰
      T.walkAmt = 0
      T.headA = Math.sin(this.t * 0.9) * 0.35
      if (this.t < this.stretchUntil) {
        T.stretch = 1
        T.bodyRx = 31; T.bodyRy = 13
        T.headX = 7; T.headY = -20; T.headA = 0.12
      } else {
        T.stretch = 0
        T.bodyRx = 24; T.bodyRy = 17
        T.headX = 0; T.headY = -26
      }
    } else {
      T.walkAmt = 1
      T.stretch = 0
      T.bodyRx = 24; T.bodyRy = 17
      T.headX = 0; T.headY = -26
      T.walkPhase += this.dt * 3.2
      const nextX = T.x + dir * 14 * this.dt
      if (nextX < 34) {
        T.x = 34
        this.walkDir = 1
        this.startPause(r)
      } else if (nextX > 106) {
        T.x = 106
        this.walkDir = -1
        this.startPause(r)
      } else {
        T.x = nextX
      }
      T.y = 68 - Math.abs(Math.sin(T.walkPhase)) * 1.6
      T.lean = Math.sin(T.walkPhase) * 0.05 * dir
      T.sx = dir
      T.headA = 0.08 * dir
    }

    T.eyeOpen = 1
    T.eyeWide = 0
    T.mouth = 0
    T.pawLift = 0
    T.curl = 0
    T.tailA = 0.5 + Math.sin(this.t * 1.4) * 0.08 + dir * 0.18
    T.tailTip = 0.45 + Math.sin(this.t * 0.9) * 0.12
    T.tailWave = this.t * 3
  }

  private startPause(r: () => number): void {
    this.pauseUntil = this.t + 1 + r() * 1.6
    if (r() < 0.3) {
      this.stretchUntil = this.pauseUntil + 2.2
      this.stretchAt = this.pauseUntil
    }
  }

  private behaveActive(): void {
    const T = this.target
    const r = this.rng
    const dir = this.walkDir
    const zooming = this.t < this.zoomieUntil

    if (zooming) {
      // zoomies：高速冲刺 + 快速转向（打滚）
      if (this.t > this.zoomieFlipAt) {
        this.zoomieFlipAt = this.t + 0.13
        this.walkDir = -this.walkDir
      }
      T.walkPhase += this.dt * 9
      T.bodyRx = 30; T.bodyRy = 13
      T.tailA = 1.1 + Math.sin(this.t * 10) * 0.35
      T.tailTip = 0.7
      T.walkAmt = 1.4
      T.sx = dir
    } else {
      if (this.t > this.zoomieAt) {
        this.zoomieUntil = this.t + 1.5
        this.zoomieAt = this.t + 9 + r() * 6
      }
      T.walkPhase += this.dt * 5.6
      T.bodyRx = 27; T.bodyRy = 14
      T.tailA = 0.9 + Math.sin(this.t * 6) * 0.15
      T.tailTip = 0.55
      T.walkAmt = 1.2
      T.sx = dir
    }

    const nextX = T.x + dir * (zooming ? 130 : 44) * this.dt
    if (nextX < 26) {
      T.x = 26
      this.walkDir = 1
    } else if (nextX > 114) {
      T.x = 114
      this.walkDir = -1
    } else {
      T.x = nextX
    }

    // 跳跃
    if (this.t > this.jumpAt) {
      this.jumpUntil = this.t + 0.72
      this.jumpAt = this.t + 2 + r() * 2.5
    }
    if (this.t < this.jumpUntil) {
      const j = clamp((this.jumpUntil - this.t) / 0.72, 0, 1)
      T.y = 68 - Math.sin(Math.PI * j) * 22
      T.bodyRx = 23; T.bodyRy = 16
      T.walkAmt = 0.2
    } else {
      T.y = 68 - Math.abs(Math.sin(T.walkPhase)) * 2.4
    }

    T.eyeOpen = 1
    T.eyeWide = 0.25
    T.mouth = 0.18
    T.pawLift = 0
    T.stretch = 0
    T.curl = 0
    T.headX = dir * 4
    T.headY = -24
    T.headA = dir * 0.12
    T.lean = Math.sin(T.walkPhase) * 0.08 * dir
    T.tailWave = this.t * 6
  }

  private behaveSleep(): void {
    const T = this.target
    T.x = 70; T.y = 70; T.bodyRx = 28; T.bodyRy = 12; T.lean = 0; T.sx = 1
    T.headX = -4; T.headY = -14; T.headA = 0.06
    T.earFlat = 0.3
    T.eyeOpen = 0.03
    T.eyeWide = 0
    T.mouth = 0
    T.pawLift = 0
    T.stretch = 0
    T.curl = 1
    T.tailA = -0.4
    T.tailTip = 0.1
    T.tailWave = this.t * 0.6
    T.walkPhase = 0
    T.walkAmt = 0
    T.bodyRy = 12 + Math.sin(this.t * 1.2) * 0.7

    // Z 粒子（Spec §6.1：蜷成一团闭眼，"Z"粒子飘出）
    if (this.t > this.zAt) {
      this.zAt = this.t + 1.1 + this.rng() * 0.4
      const hx = 70 + T.headX
      const hy = 70 + T.headY
      this.particles.push({
        x: hx + 8, y: hy - 14,
        vx: 7, vy: -9,
        life: 1.7, maxLife: 1.7,
        text: 'Z', size: 9 + this.rng() * 5,
      })
    }
  }

  // ---------------------------------------------------------------- 主循环

  private dt = 0

  private step(dt: number): void {
    this.dt = dt

    // 行为目标
    switch (this.mood) {
      case 'relaxed':
        this.behaveRelaxed()
        break
      case 'wander':
        this.behaveWander()
        break
      case 'active':
        this.behaveActive()
        break
      case 'sleep':
        this.behaveSleep()
        break
    }

    // 眼神跟随鼠标
    this.applyPointer()

    // 惊吓覆盖（点击）
    if (this.t < this.startleAt + this.startleDuration) {
      const k = clamp((this.startleAt + this.startleDuration - this.t) / this.startleDuration, 0, 1)
      this.target.y = 68 - Math.sin(Math.PI * (1 - k)) * 13
      this.target.earFlat = k
      this.target.eyeWide = k
      this.target.eyeOpen = 1
      this.target.pupilX = 0
      this.target.pupilY = 0
      this.target.mouth = 0.3
      this.target.walkAmt = 0
      this.target.tailA = -1.1
    }

    // 平滑逼近目标
    const P = this.pose
    const T = this.target
    const s = (p: keyof Pose, k = 10): void => {
      ;(P as unknown as Record<string, number>)[p] = lerp(
        (P as unknown as Record<string, number>)[p] as number,
        (T as unknown as Record<string, number>)[p] as number,
        1 - Math.exp(-k * dt),
      )
    }
    s('x', 8); s('y', 9); s('bodyRx', 6); s('bodyRy', 6); s('lean', 8); s('sx', 14)
    s('headX', 10); s('headY', 10); s('headA', 8)
    s('earFlat', 9); s('eyeOpen', 14); s('pupilX', 12); s('pupilY', 12); s('eyeWide', 10)
    s('mouth', 10); s('pawLift', 10); s('stretch', 6); s('curl', 6)
    s('tailA', 8); s('tailTip', 8); s('tailWave', 8)
    s('walkPhase', 8); s('walkAmt', 8)

    // 粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.life -= dt
      if (p.life <= 0) this.particles.splice(i, 1)
    }

    this.draw()
  }

  private applyPointer(): void {
    const T = this.target
    if (!this.pointer) {
      T.pupilX = 0
      T.pupilY = 0
      return
    }
    const headCx = this.pose.x + this.pose.headX * this.pose.sx
    const headCy = this.pose.y + this.pose.headY
    const dx = (this.pointer.x - headCx) / 26
    const dy = (this.pointer.y - headCy) / 26
    T.pupilX = clamp(dx, -1, 1) * 1.7
    T.pupilY = clamp(dy, -1, 1) * 1.3
    T.headA = clamp(dx, -1, 1) * 0.1
  }

  // ---------------------------------------------------------------- 绘制

  private draw(): void {
    const ctx = this.ctx
    if (!ctx || !this.canvas) return
    const cssW = this.canvas.clientWidth || 100
    const cssH = this.canvas.clientHeight || 100
    const s = Math.min(cssW / DESIGN_W, cssH / DESIGN_H)
    const ox = (cssW - DESIGN_W * s) / 2
    const oy = (cssH - DESIGN_H * s) / 2

    ctx.clearRect(0, 0, cssW, cssH)
    ctx.save()
    ctx.translate(ox, oy)
    ctx.scale(s, s)

    const P = this.pose
    const curling = P.curl > 0.6

    this.drawShadow(ctx, P)
    if (!curling) this.drawTail(ctx, P)
    this.drawLegs(ctx, P)
    this.drawBody(ctx, P)
    if (curling) this.drawCurledTail(ctx, P)
    this.drawHead(ctx, P)
    this.drawStartleBubble(ctx, P)

    // 粒子（Z 等）
    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1)
      ctx.fillStyle = '#93c5fd'
      ctx.font = `bold ${p.size}px 'Segoe UI', sans-serif`
      ctx.fillText(p.text, p.x, p.y)
    }
    ctx.globalAlpha = 1

    ctx.restore()
  }

  private drawShadow(ctx: CanvasRenderingContext2D, P: Pose): void {
    const height = Math.max(0, GROUND_Y - P.y)
    const k = clamp(1 - height / 30, 0.25, 1)
    ctx.globalAlpha = 0.16 * k
    ctx.fillStyle = '#000'
    ctx.beginPath()
    ctx.ellipse(P.x, GROUND_Y + 2, P.bodyRx * 0.9 * k, 3.5 * k, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }

  private drawTail(ctx: CanvasRenderingContext2D, P: Pose): void {
    const bx = P.x - P.sx * P.bodyRx * 0.72
    const by = P.y - 2
    const ex = bx - P.sx * (8 + P.tailTip * 14)
    const ey = by - 7 - P.tailTip * 20 - Math.sin(P.tailWave) * 2.5
    const cx = bx - P.sx * 14
    const cy = by - 5 - P.tailTip * 12

    ctx.save()
    ctx.translate(bx, by)
    ctx.rotate(P.tailA * 0.25)
    ctx.translate(-bx, -by)

    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.lineWidth = 10
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.quadraticCurveTo(cx, cy, ex, ey)
    ctx.stroke()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(bx, by)
    ctx.quadraticCurveTo(cx, cy, ex, ey)
    ctx.stroke()
    ctx.restore()
  }

  private drawLegs(ctx: CanvasRenderingContext2D, P: Pose): void {
    const sitting = P.walkAmt < 0.25 && P.stretch < 0.5

    if (sitting) {
      // 前爪（坐姿）
      const lift = P.pawLift
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)'
      ctx.lineWidth = 9
      ctx.beginPath()
      ctx.moveTo(P.x - 7, P.y + P.bodyRy - 2)
      ctx.lineTo(P.x - 7 - lift * 2, GROUND_Y - 3 - lift * 9)
      ctx.stroke()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 6.5
      ctx.beginPath()
      ctx.moveTo(P.x - 7, P.y + P.bodyRy - 2)
      ctx.lineTo(P.x - 7 - lift * 2, GROUND_Y - 3 - lift * 9)
      ctx.stroke()
      // 另一只爪
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)'
      ctx.lineWidth = 9
      ctx.beginPath()
      ctx.moveTo(P.x + 7, P.y + P.bodyRy - 2)
      ctx.lineTo(P.x + 7, GROUND_Y - 3)
      ctx.stroke()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 6.5
      ctx.beginPath()
      ctx.moveTo(P.x + 7, P.y + P.bodyRy - 2)
      ctx.lineTo(P.x + 7, GROUND_Y - 3)
      ctx.stroke()
      return
    }

    if (P.stretch > 0.5) {
      // 伸懒腰：前腿前伸
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)'
      ctx.lineWidth = 9
      ctx.beginPath()
      ctx.moveTo(P.x + 6, P.y + 2)
      ctx.lineTo(P.x + 24, GROUND_Y - 4)
      ctx.stroke()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 6.5
      ctx.beginPath()
      ctx.moveTo(P.x + 6, P.y + 2)
      ctx.lineTo(P.x + 24, GROUND_Y - 4)
      ctx.stroke()
      return
    }

    // 行走 / 奔跑：四腿交替
    const amp = P.walkAmt
    const legs = [
      { hx: P.x - P.bodyRx * 0.45, phase: 0 },
      { hx: P.x + P.bodyRx * 0.45, phase: Math.PI },
      { hx: P.x - P.bodyRx * 0.5, phase: Math.PI * 0.5 },
      { hx: P.x + P.bodyRx * 0.5, phase: Math.PI * 1.5 },
    ]
    for (const leg of legs) {
      const swing = Math.sin(P.walkPhase + leg.phase) * amp
      const footX = leg.hx + swing * 5 * P.sx
      const footY = GROUND_Y - 2 - Math.max(0, Math.sin(P.walkPhase + leg.phase)) * 3
      ctx.lineCap = 'round'
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.8)'
      ctx.lineWidth = 8.5
      ctx.beginPath()
      ctx.moveTo(leg.hx, P.y + P.bodyRy * 0.4)
      ctx.lineTo(footX, footY)
      ctx.stroke()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.moveTo(leg.hx, P.y + P.bodyRy * 0.4)
      ctx.lineTo(footX, footY)
      ctx.stroke()
    }
  }

  private drawBody(ctx: CanvasRenderingContext2D, P: Pose): void {
    ctx.save()
    ctx.translate(P.x, P.y)
    ctx.rotate(P.lean)

    // 阴影层次
    ctx.beginPath()
    ctx.ellipse(0, 2, P.bodyRx, P.bodyRy, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#e2e8f0'
    ctx.fill()

    ctx.beginPath()
    ctx.ellipse(0, 0, P.bodyRx, P.bodyRy, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.9)'
    ctx.lineWidth = 1.6
    ctx.stroke()

    // 底部柔光阴影
    ctx.beginPath()
    ctx.ellipse(0, P.bodyRy * 0.45, P.bodyRx * 0.8, P.bodyRy * 0.5, 0, 0, Math.PI)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)'
    ctx.fill()

    ctx.restore()
  }

  private drawCurledTail(ctx: CanvasRenderingContext2D, P: Pose): void {
    // 睡觉时尾巴绕身
    ctx.save()
    ctx.translate(P.x, P.y)
    ctx.rotate(Math.sin(P.tailWave) * 0.08)
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.lineWidth = 9
    ctx.beginPath()
    ctx.arc(0, 0, P.bodyRx - 2, Math.PI * 0.15, Math.PI * 1.05)
    ctx.stroke()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 6.5
    ctx.beginPath()
    ctx.arc(0, 0, P.bodyRx - 2, Math.PI * 0.15, Math.PI * 1.05)
    ctx.stroke()
    ctx.restore()
  }

  private drawHead(ctx: CanvasRenderingContext2D, P: Pose): void {
    const hx = P.x + P.headX * P.sx
    const hy = P.y + P.headY

    ctx.save()
    ctx.translate(hx, hy)
    ctx.rotate(P.headA)
    ctx.scale(P.sx, 1)

    // 耳朵
    this.drawEar(ctx, -1, P.earFlat)
    this.drawEar(ctx, 1, P.earFlat)

    // 头
    ctx.beginPath()
    ctx.arc(0, 0, 13, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.9)'
    ctx.lineWidth = 1.6
    ctx.stroke()

    // 胡须
    if (P.curl < 0.6) {
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.55)'
      ctx.lineWidth = 1
      for (const [sy, dy] of [
        [1, -2],
        [3, 0],
        [5, 2],
      ] as const) {
        ctx.beginPath()
        ctx.moveTo(-8, sy)
        ctx.lineTo(-16, sy + dy)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(8, sy)
        ctx.lineTo(16, sy + dy)
        ctx.stroke()
      }
    }

    // 眼睛（跟随鼠标 + 眨眼 + 惊吓瞪大）
    const eyeR = 3.6 + P.eyeWide * 0.9
    const eyeOpen = Math.max(P.eyeOpen, 0.05)
    for (const ex of [-4.5, 4.5]) {
      ctx.save()
      ctx.translate(ex, 0.5)
      if (eyeOpen < 0.3) {
        // 闭眼：一条弧线
        ctx.strokeStyle = '#475569'
        ctx.lineWidth = 1.4
        ctx.beginPath()
        ctx.arc(0, 0, eyeR * 0.8, Math.PI * 0.15, Math.PI * 0.85)
        ctx.stroke()
      } else {
        ctx.scale(1, eyeOpen)
        ctx.beginPath()
        ctx.arc(0, 0, eyeR, 0, Math.PI * 2)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.5)'
        ctx.lineWidth = 1
        ctx.stroke()
        // 瞳孔
        const pr = 1.8 - P.eyeWide * 0.9
        ctx.beginPath()
        ctx.arc(P.pupilX, P.pupilY, Math.max(0.6, pr), 0, Math.PI * 2)
        ctx.fillStyle = '#1e293b'
        ctx.fill()
        // 高光
        ctx.beginPath()
        ctx.arc(P.pupilX + 0.7, P.pupilY - 0.7, Math.max(0.3, pr * 0.45), 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.fill()
      }
      ctx.restore()
    }

    // 鼻子
    ctx.beginPath()
    ctx.moveTo(-1.7, 3.8)
    ctx.lineTo(1.7, 3.8)
    ctx.lineTo(0, 6)
    ctx.closePath()
    ctx.fillStyle = '#fda4af'
    ctx.fill()
    ctx.strokeStyle = '#f472b6'
    ctx.lineWidth = 0.7
    ctx.stroke()

    // 嘴
    if (P.mouth > 0.3) {
      // 打哈欠 / 喘气
      ctx.beginPath()
      ctx.ellipse(0, 8, 3.2, 2.6 * P.mouth, 0, 0, Math.PI * 2)
      ctx.fillStyle = '#7f1d1d'
      ctx.fill()
    } else {
      ctx.strokeStyle = '#64748b'
      ctx.lineWidth = 1.1
      ctx.beginPath()
      ctx.moveTo(0, 6)
      ctx.quadraticCurveTo(2.2, 8.4, 4.6, 7.6)
      ctx.moveTo(0, 6)
      ctx.quadraticCurveTo(-2.2, 8.4, -4.6, 7.6)
      ctx.stroke()
    }

    ctx.restore()
  }

  private drawEar(ctx: CanvasRenderingContext2D, side: 1 | -1, flat: number): void {
    const bx = side * 6.5
    const by = -6
    const tilt = flat * 0.5 * side
    ctx.save()
    ctx.translate(bx, by)
    ctx.rotate(tilt)
    // 外耳
    ctx.beginPath()
    ctx.moveTo(-3, 3)
    ctx.lineTo(-6 + flat * 4, -9)
    ctx.lineTo(3, -6 + flat * 3)
    ctx.closePath()
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.9)'
    ctx.lineWidth = 1.4
    ctx.stroke()
    // 内耳
    ctx.beginPath()
    ctx.moveTo(-1.2, 0.5)
    ctx.lineTo(-4.4 + flat * 3, -6.4)
    ctx.lineTo(1.4, -4.2 + flat * 2)
    ctx.closePath()
    ctx.fillStyle = '#fbcfe8'
    ctx.fill()
    ctx.restore()
  }

  private drawStartleBubble(ctx: CanvasRenderingContext2D, P: Pose): void {
    if (this.t >= this.startleAt + this.startleDuration) return
    const hx = P.x + P.headX * P.sx
    const hy = P.y + P.headY
    const x = hx + 8 * P.sx
    const y = hy - 20
    ctx.beginPath()
    ctx.arc(x, y, 7, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#f43f5e'
    ctx.lineWidth = 1.6
    ctx.stroke()
    ctx.fillStyle = '#f43f5e'
    ctx.font = 'bold 12px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', x, y + 0.5)
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
  }
}
