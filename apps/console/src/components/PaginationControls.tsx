interface PaginationControlsProps {
  page: number;
  pageCount: number;
  total: number;
  startIndex: number;
  endIndex: number;
  onPageChange: (page: number) => void;
}

function visiblePages(page: number, pageCount: number): number[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  return [start, start + 1, start + 2, start + 3, start + 4];
}

export function PaginationControls(props: PaginationControlsProps) {
  const { page, pageCount, total, startIndex, endIndex, onPageChange } = props;
  if (pageCount <= 1) {
    return null;
  }

  const pages = visiblePages(page, pageCount);
  return (
    <div className="pagination-bar">
      <div className="small muted">
        Showing {total === 0 ? 0 : startIndex + 1}-{endIndex} of {total}
      </div>
      <div className="row-actions pagination-actions">
        <button type="button" className="btn ghost small" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          Prev
        </button>
        {pages.map((p) => (
          <button
            key={p}
            type="button"
            className={`btn ghost small ${p === page ? "pagination-page-active" : ""}`}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onPageChange(p)}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          className="btn ghost small"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
        >
          Next
        </button>
      </div>
    </div>
  );
}
