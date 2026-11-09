// Forms that destroy something ask first (data-confirm holds the question).
for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.getAttribute("data-confirm") || "Are you sure?")) event.preventDefault();
  });
}
