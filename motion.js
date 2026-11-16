/* Scoot micro-interactions — dependency free, progressive enhancement. */
(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  // A genuine interactive tour of *illustrative* UI states, never live telemetry.
  const preview = document.querySelector(".hero-art");
  const modeButtons = Array.from(document.querySelectorAll("[data-preview-mode]"));
  const screens = Array.from(document.querySelectorAll("[data-preview-screen]"));
  const connection = document.getElementById("previewConnection");
  const previewStatus = {
    ride: "● Connected",
    nav: "● Navigating",
    park: "● Saved location"
  };

  function switchPreview(mode) {
    if (!Object.prototype.hasOwnProperty.call(previewStatus, mode) || !preview) return;
    preview.dataset.mode = mode;
    for (const button of modeButtons) {
      const active = button.dataset.previewMode === mode;
      button.setAttribute("aria-pressed", String(active));
    }
    for (const screen of screens) {
      screen.hidden = screen.dataset.previewScreen !== mode;
    }
    if (connection) connection.textContent = previewStatus[mode];
  }

  for (const button of modeButtons) {
    button.addEventListener("click", () => switchPreview(button.dataset.previewMode));
  }
  switchPreview("ride");

  // Incoming content reveals only after JS is present. Without JS, every section is visible.
  if (!reducedMotion.matches && "IntersectionObserver" in window) {
    const groups = [
      ".ticker-item",
      ".section-heading",
      ".ride-card",
      ".feature-card",
      ".release-layout > *",
      ".get",
      ".step",
      ".faq-layout > *",
      ".footer-upper"
    ];
    const elements = Array.from(document.querySelectorAll(groups.join(", ")));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove("motion-pending");
        entry.target.classList.add("motion-seen");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -45px 0px", threshold: 0.08 });

    elements.forEach((element, index) => {
      const { top } = element.getBoundingClientRect();
      if (top < window.innerHeight * .96) return;
      const delay = element.matches(".ride-card, .feature-card, .step, .ticker-item")
        ? (Array.from(element.parentElement.children).indexOf(element) % 4) * 80
        : 0;
      element.style.setProperty("--reveal-delay", delay + "ms");
      element.classList.add("motion-pending");
      observer.observe(element);
    });

    // Respect any accessibility preference changed while the page is open.
    reducedMotion.addEventListener("change", event => {
      if (!event.matches) return;
      observer.disconnect();
      for (const element of elements) element.classList.remove("motion-pending");
    }, { once: true });
  }

  // Give the hero some depth on desktops; avoid pointer tracking on phones / reduced motion.
  if (preview && finePointer.matches && !reducedMotion.matches) {
    let frame = 0;
    let currentX = 0, currentY = 0;

    const update = () => {
      preview.style.setProperty("--cursor-x", (currentX * 17).toFixed(1) + "px");
      preview.style.setProperty("--cursor-y", (currentY * 12).toFixed(1) + "px");
      preview.style.setProperty("--phone-x", (currentX * 5).toFixed(1) + "px");
      preview.style.setProperty("--phone-y", (currentY * 4).toFixed(1) + "px");
      frame = 0;
    };
    preview.addEventListener("pointermove", event => {
      const rect = preview.getBoundingClientRect();
      currentX = (event.clientX - rect.left) / rect.width * 2 - 1;
      currentY = (event.clientY - rect.top) / rect.height * 2 - 1;
      if (!frame) frame = window.requestAnimationFrame(update);
    }, { passive: true });
    preview.addEventListener("pointerleave", () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      currentX = currentY = 0;
      update();
    });
  }

  // Reading progress is a subtle location cue, not a scrolling hijack.
  const progress = document.getElementById("scrollProgress");
  const backTop = document.getElementById("backTop");
  let scrolling = false;
  function updateScroll() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const fraction = Math.max(0, Math.min(1, window.scrollY / max));
    if (progress) progress.style.transform = "scaleX(" + fraction.toFixed(4) + ")";
    if (backTop) backTop.classList.toggle("shown", window.scrollY > Math.max(480, window.innerHeight * .7));
    scrolling = false;
  }
  window.addEventListener("scroll", () => {
    if (scrolling) return;
    scrolling = true;
    window.requestAnimationFrame(updateScroll);
  }, { passive: true });
  window.addEventListener("resize", updateScroll, { passive: true });
  updateScroll();
})();
