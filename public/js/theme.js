// Loaded render-blocking in <head> so the theme applies before first paint.
// The theme follows the system setting until the switch is used; after that
// the choice is saved in localStorage. Adapted from alexandermorgan.dev.
(() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const saved = () => {
    try {
      const value = localStorage.getItem("theme");
      return value === "light" || value === "dark" ? value : null;
    } catch {
      return null;
    }
  };
  const syncSwitch = () => {
    const toggle = document.querySelector(".theme-toggle .switch");
    if (toggle) toggle.checked = root.dataset.theme === "dark";
  };

  root.dataset.theme = saved() ?? (media.matches ? "dark" : "light");
  media.addEventListener("change", (evt) => {
    if (saved()) return;
    root.dataset.theme = evt.matches ? "dark" : "light";
    syncSwitch();
  });

  function setTheme(theme) {
    const apply = () => {
      root.dataset.theme = theme;
      try {
        localStorage.setItem("theme", theme);
      } catch {
        // storage unavailable: the choice lasts for this page only
      }
    };
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();
    // Sweep the new theme across the page in a circle growing from the switch,
    // so text never passes through a low-contrast midpoint.
    const box = document.querySelector(".theme-toggle")?.getBoundingClientRect();
    const x = box ? box.left + box.width / 2 : innerWidth / 2;
    const y = box ? box.top + box.height / 2 : 0;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const [duration, easing] = getComputedStyle(root).getPropertyValue("--theme-transition").trim().split(/\s+/);
    const current = (setTheme.changes = (setTheme.changes ?? 0) + 1);
    root.classList.add("theme-changing");
    const change = document.startViewTransition(apply);
    change.ready
      .then(() =>
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: parseFloat(duration) || 500, easing: easing || "ease-in-out", pseudoElement: "::view-transition-new(root)" },
        ),
      )
      .catch(() => {});
    change.finished.finally(() => current === setTheme.changes && root.classList.remove("theme-changing"));
  }

  document.addEventListener("change", (evt) => {
    if (evt.target instanceof Element && evt.target.matches(".theme-toggle .switch")) {
      setTheme(evt.target.checked ? "dark" : "light");
    }
  });
  document.addEventListener("DOMContentLoaded", syncSwitch);
})();
