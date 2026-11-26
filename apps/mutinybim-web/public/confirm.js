// Show the chosen recipient and access when confirming an ownership offer.
for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    const lines = [form.getAttribute("data-confirm") || "Are you sure?"];
    for (const field of form.querySelectorAll("select[data-confirm-label]")) {
      lines.push(field.dataset.confirmLabel + ": " + field.selectedOptions[0].textContent);
    }
    if (!window.confirm(lines.join("\n"))) event.preventDefault();
  });
}
