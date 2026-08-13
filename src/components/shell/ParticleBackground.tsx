"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

/**
 * AgenticBiz particle field — lightweight interactive canvas.
 * - Individual drifting particles (never grouped/tiled)
 * - Crisp 1px dots with subtle glow, 60fps, DPR-aware
 * - Interaction: particles gently repel from cursor / finger
 * - Connection lines appear when particles are close (short links motif)
 * - Auto-pauses when tab hidden; ~40 particles max for perf
 * - Theme-aware: light mode uses brighter, more vibrant colors so the
 *   field reads clearly on the pale background (13 Aug 2026).
 */
export function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = true;
    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Theme-aware styling — recomputed on every frame so theme flips take
    // effect immediately without a remount.
    const isDark = () => document.documentElement.classList.contains("dark");

    type P = { x: number; y: number; vx: number; vy: number; r: number; hue: number };
    let particles: P[] = [];

    const MOUSE = { x: -9999, y: -9999, active: false };

    const spawn = (): P => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 1.6 + 0.8,
      hue: Math.random() < 0.6 ? 252 : 210, // purple / blue
    });

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Light mode: denser field so the vibrancy reads clearly.
      const density = document.documentElement.classList.contains("dark") ? 26000 : 19000;
      const target = Math.min(Math.floor((width * height) / density), 60);
      particles = Array.from({ length: Math.max(target, 18) }, spawn);
    };

    const onPointer = (e: PointerEvent) => {
      MOUSE.x = e.clientX;
      MOUSE.y = e.clientY;
      MOUSE.active = true;
    };
    const onLeave = () => {
      MOUSE.active = false;
      MOUSE.x = -9999;
      MOUSE.y = -9999;
    };

    const draw = () => {
      if (!running) return;
      ctx.clearRect(0, 0, width, height);

      const dark = isDark();
      // Light mode: brighter, bigger, richer dots + stronger links so they
      // really pop on the pale bg (user: "not bright and vibrant enough").
      const dotSat = dark ? 80 : 100;
      const dotLight = dark ? 66 : 50;
      const dotActiveLight = dark ? 72 : 55;
      const dotAlpha = dark ? 0.55 : 1;
      const dotScale = dark ? 1 : 1.8;
      const linkAlphaBase = dark ? 0.28 : 0.85;
      const linkWidth = dark ? 0.6 : 1.4;
      const linkHue = dark ? "124,108,255" : "91,76,240";

      // Connection lines (short links) — draw before dots
      const linkDist = 110;
      ctx.lineWidth = linkWidth;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < linkDist * linkDist) {
            const alpha = (1 - Math.sqrt(d2) / linkDist) * linkAlphaBase;
            ctx.strokeStyle = `rgba(${linkHue},${alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Particles
      const repulse = 90;
      for (const p of particles) {
        // gentle drift
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -10) p.x = width + 10;
        if (p.x > width + 10) p.x = -10;
        if (p.y < -10) p.y = height + 10;
        if (p.y > height + 10) p.y = -10;

        // pointer repulsion
        if (MOUSE.active) {
          const dx = p.x - MOUSE.x;
          const dy = p.y - MOUSE.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < repulse * repulse && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const force = ((repulse - d) / repulse) * 0.9;
            p.x += (dx / d) * force;
            p.y += (dy / d) * force;
          }
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * dotScale, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, ${dotSat}%, ${MOUSE.active ? dotActiveLight : dotLight}%, ${dotAlpha})`;
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      running = !document.hidden;
      if (running) {
        raf = requestAnimationFrame(draw);
      } else {
        cancelAnimationFrame(raf);
      }
    };

    resize();
    draw();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [resolvedTheme]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-[-1]"
      aria-hidden="true"
    />
  );
}
