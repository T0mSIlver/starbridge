const bridge = window.starbridgeServer;
const url = document.getElementById("url");
const note = document.getElementById("note");
url.value = bridge.current || "";
document.getElementById("form").addEventListener("submit", (e) => {
  e.preventDefault();
  bridge.save(url.value);
});
document
  .getElementById("default")
  .addEventListener("click", () => bridge.save("https://starbridge.run"));
bridge.onError((message) => {
  note.textContent = message;
  note.className = "error";
});
