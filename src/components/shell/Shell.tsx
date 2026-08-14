"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { lockNow } from "@/lib/auth";
import {
  LayoutDashboard,
  Send,
  ShieldCheck,
  Clock,
  Network,
  MessageSquare,
  MessagesSquare,
  Film,
  TrendingUp,
  Wrench,
  User,
  AppWindow,
  Settings,
  Sun,
  Moon,
  Lock,
  Command,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Daily Brief", icon: LayoutDashboard },
  { href: "/dispatch", label: "Dispatch", icon: Send },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck },
  { href: "/crons", label: "Cron Monitor", icon: Clock },
  { href: "/agents", label: "Agents", icon: Network },
  { href: "/sessions", label: "Sessions", icon: MessageSquare },
  { href: "/channels", label: "Channels", icon: MessagesSquare },
  { href: "/chat", label: "Chat + Voice", icon: MessageSquare },
  { href: "/studio", label: "Content Studio", icon: Film },
  { href: "/trading", label: "Trading", icon: TrendingUp },
  { href: "/dev", label: "Development", icon: Wrench },
  { href: "/personal", label: "Personal", icon: User },
  { href: "/native", label: "Native UI", icon: AppWindow },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setMounted(true), []);

  // Snap the bottom nav back to the active screen after 2.5s of no scrolling.
  const onNavScroll = () => {
    if (navTimer.current) clearTimeout(navTimer.current);
    navTimer.current = setTimeout(() => {
      const nav = navRef.current;
      if (!nav) return;
      const activeIdx = NAV.findIndex(
        (item) => pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href))
      );
      if (activeIdx < 0) return;
      const el = nav.children[activeIdx] as HTMLElement | undefined;
      if (!el) return;
      nav.scrollTo({ left: el.offsetLeft - nav.clientWidth / 2 + el.clientWidth / 2, behavior: "smooth" });
    }, 2500);
  };

  // Snap on mount / route change too (so the active tab is always centered).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const activeIdx = NAV.findIndex(
      (item) => pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href))
    );
    if (activeIdx < 0) return;
    const el = nav.children[activeIdx] as HTMLElement | undefined;
    if (!el) return;
    nav.scrollTo({ left: el.offsetLeft - nav.clientWidth / 2 + el.clientWidth / 2, behavior: "auto" });
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r p-4 md:flex" style={{ borderColor: "var(--card-border)", background: "var(--bg-2)" }}>
        <Link href="/" className="mb-6 flex items-center gap-2 px-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}>
            <Command className="h-5 w-5 text-white" />
          </span>
          <span className="text-lg font-bold leading-tight">
            Hermes OS
            <span className="block text-[10px] font-medium uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>Mission Control v2</span>
          </span>
        </Link>

        <nav className="flex-1 space-y-0.5 overflow-y-auto">
          {NAV.map((item) => {
            const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active ? "font-semibold" : ""
                }`}
                style={
                  active
                    ? { background: "rgba(124,108,255,0.14)", color: "var(--accent)" }
                    : { color: "var(--text-dim)" }
                }
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header
          className="sticky top-0 z-40 flex h-14 items-center justify-between border-b px-4 backdrop-blur-md"
          style={{ borderColor: "var(--card-border)", background: "color-mix(in srgb, var(--bg) 80%, transparent)" }}
        >
          <div className="flex items-center gap-2 md:hidden">
            <Link href="/" className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}>
                <Command className="h-4 w-4 text-white" />
              </span>
              <span className="text-sm font-bold">Hermes OS</span>
            </Link>
          </div>

          <button
            onClick={() => setPaletteOpen(true)}
            className="hidden items-center gap-2 rounded-lg border px-3 py-1.5 text-sm md:flex"
            style={{ borderColor: "var(--card-border)", color: "var(--text-faint)" }}
          >
            <Command className="h-3.5 w-3.5" />
            Quick dispatch… <kbd className="ml-2 rounded border px-1 text-[10px]" style={{ borderColor: "var(--card-border)" }}>⌘K</kbd>
          </button>
          <div className="md:hidden" />

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                lockNow();
                window.location.reload();
              }}
              className="flex h-9 w-9 items-center justify-center rounded-lg border"
              style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
              aria-label="Lock dashboard"
              title="Lock dashboard"
            >
              <Lock className="h-4 w-4" />
            </button>
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="flex h-9 w-9 items-center justify-center rounded-lg border"
              style={{ borderColor: "var(--card-border)" }}
              aria-label="Toggle theme"
            >
              {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 pb-28 md:px-8 md:pb-6" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)" }}>
          {children}
        </main>
      </div>

      {/* Mobile bottom nav — horizontally scrollable, ALL pages reachable */}
      <nav
        ref={navRef}
        onScroll={onNavScroll}
        className="fixed bottom-0 left-0 right-0 z-40 flex items-center gap-1 overflow-x-auto border-t px-2 py-2 backdrop-blur-md md:hidden"
        style={{ borderColor: "var(--card-border)", background: "color-mix(in srgb, var(--bg-2) 92%, transparent)", scrollbarWidth: "none", paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}
      >
        {NAV.map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="flex shrink-0 flex-col items-center gap-0.5 px-3 py-1" style={{ color: active ? "var(--accent)" : "var(--text-faint)" }}>
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-medium whitespace-nowrap">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Command palette */}
      {paletteOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-24" onClick={() => setPaletteOpen(false)}>
          <div className="card w-full max-w-lg p-0" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--card-border)" }}>
              <Command className="h-4 w-4" style={{ color: "var(--text-faint)" }} />
              <input
                autoFocus
                placeholder="Search pages…"
                className="w-full bg-transparent text-sm outline-none"
                style={{ color: "var(--text)" }}
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-2">
              {NAV.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setPaletteOpen(false)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm"
                    style={{ color: "var(--text-dim)" }}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
