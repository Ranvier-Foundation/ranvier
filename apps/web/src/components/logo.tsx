/** Hop logo: lowercase wordmark followed by two stepping square nodes. */
export function Logo() {
  return (
    <span className="inline-flex items-start text-[32px] leading-none font-bold tracking-[-0.055em]">
      ranvier
      <span
        aria-hidden="true"
        className="relative mb-2 ml-[3px] size-3.5 shrink-0 self-end text-brand"
      >
        <span className="absolute top-2 left-0 size-1.5 bg-current" />
        <span className="absolute top-0 left-2 size-1.5 bg-current" />
      </span>
    </span>
  );
}
