/* Web-only touches to the shared page: home-screen widgets are an Android feature, so their settings are hidden. */
(function () {
  const hideSection = title => {
    const h = [...document.querySelectorAll('#v-settings .section-h')].find(x => x.textContent.trim() === title);
    if (!h) return;
    h.hidden = true;
    for (let n = h.nextElementSibling; n && !n.classList.contains('section-h'); n = n.nextElementSibling) n.hidden = true;
  };
  ['Home-screen widgets', 'Defaults for all widgets'].forEach(hideSection);
})();
