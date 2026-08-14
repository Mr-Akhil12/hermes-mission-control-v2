// Skeleton shimmer primitives — used across the dashboard so nothing
// ever looks empty while loading.

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return <div className={`skeleton ${className ?? ""}`} style={style} />;
}

/** Skeleton row for the conversation sidebar list. */
export function SessionListSkeleton() {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="space-y-1.5 rounded-lg px-3 py-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton message bubbles while history loads. */
export function MessageSkeleton() {
  return (
    <div className="space-y-4 p-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`space-y-2 rounded-2xl px-4 py-3 ${
              i % 2 === 0 ? "w-2/3" : "w-3/4"
            }`}
          >
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            {i % 2 === 1 && <Skeleton className="h-3 w-2/3" />}
          </div>
        </div>
      ))}
    </div>
  );
}
