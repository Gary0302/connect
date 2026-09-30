document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(target.innerText);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select the commands";
    }
    setTimeout(() => (button.textContent = label), 1600);
  });
});
