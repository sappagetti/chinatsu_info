type LoadingBarProps = {
  label?: string;
};

export function LoadingBar({ label = "読み込み中…" }: LoadingBarProps) {
  return (
    <div className="loading-wrap" role="status" aria-live="polite" aria-label={label}>
      <div className="loading-track" aria-hidden="true">
        <span className="loading-fill" />
      </div>
      <p className="loading-label">{label}</p>
    </div>
  );
}

