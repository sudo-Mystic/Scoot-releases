/* Minimal progressive enhancement. Keep every section readable without JS. */
(() => {
  "use strict";

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches || !("IntersectionObserver" in window)) return;

  const selectors = [
    ".section-heading",
    ".ride-card",
    ".feature-card",
    ".release-layout > *",
    ".get",
    ".step",
    ".faq-layout > *"
  ].join(", ");
  const items = Array.from(document.querySelectorAll(selectors));

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.remove("motion-pending");
      entry.target.classList.add("motion-seen");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -24px 0px", threshold: 0.04 });

  for (const item of items) {
    // Already visible content should never flash or wait for an observer.
    if (item.getBoundingClientRect().top < window.innerHeight * 0.92) continue;
    item.classList.add("motion-pending");
    observer.observe(item);
  }

  reduced.addEventListener("change", event => {
    if (!event.matches) return;
    observer.disconnect();
    for (const item of items) {
      item.classList.remove("motion-pending");
      item.classList.add("motion-seen");
    }
  });
})();
