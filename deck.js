// Hexa investor deck: scroll-snap navigation, progress bar, slide counter.
// External file (not inline) so it satisfies the site CSP script-src 'self'.
(function () {
  var deck = document.getElementById('deck');
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var progress = document.getElementById('progress');
  var cur = document.getElementById('cur');
  document.getElementById('total').textContent = slides.length;

  function update() {
    var i = Math.round(deck.scrollTop / window.innerHeight);
    i = Math.max(0, Math.min(slides.length - 1, i));
    cur.textContent = i + 1;
    progress.style.width = (i / (slides.length - 1) * 100) + '%';
  }
  deck.addEventListener('scroll', function () { window.requestAnimationFrame(update); }, { passive: true });

  function go(n) {
    var i = Math.round(deck.scrollTop / window.innerHeight) + n;
    i = Math.max(0, Math.min(slides.length - 1, i));
    deck.scrollTo({ top: i * window.innerHeight, behavior: 'smooth' });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { e.preventDefault(); deck.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (e.key === 'End') { e.preventDefault(); deck.scrollTo({ top: slides.length * window.innerHeight, behavior: 'smooth' }); }
    else if (e.key === 'p' || e.key === 'P') { window.print(); }
  });
  update();
})();
