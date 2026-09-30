// Render the actual PDF locally: mobile browsers do not reliably display PDF iframes.
(() => {
  let sequence = 0, loadingTask = null, renderTask = null, currentFile = null;
  let library;
  const frame = () => document.getElementById('receiptFrame');
  const send = () => document.getElementById('receiptSendBtn');
  async function clear() {
    sequence++;
    currentFile = null;
    renderTask?.cancel(); renderTask = null;
    const previous = loadingTask; loadingTask = null;
    frame()?.replaceChildren();
    if (previous) await previous.destroy().catch(() => {});
  }
  async function show(file) {
    const clearing = clear(), version = sequence;
    await clearing;
    if (version !== sequence) return;
    currentFile = file;
    const host = frame();
    host.dataset.ready = 'false'; send().disabled = true;
    const status = document.createElement('p');
    status.className = 'document-preview-status'; status.setAttribute('role', 'status');
    status.textContent = 'Loading preview…'; host.append(status);
    try {
      library ||= import('/assets/vendor/pdfjs-legacy.mjs');
      const pdfjs = await library;
      if (version !== sequence) return;
      pdfjs.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs-legacy-worker.mjs';
      const data = new Uint8Array(await file.arrayBuffer());
      if (version !== sequence) return;
      loadingTask = pdfjs.getDocument({data, useSystemFonts: true, isEvalSupported: false});
      const pdf = await loadingTask.promise;
      for (let number = 1; number <= pdf.numPages; number++) {
        if (version !== sequence) return;
        const page = await pdf.getPage(number);
        if (version !== sequence) return;
        const natural = page.getViewport({scale: 1});
        const width = Math.max(240, Math.min(host.clientWidth - 24, 800));
        const viewport = page.getViewport({scale: width / natural.width});
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `PDF preview, page ${number} of ${pdf.numPages}`);
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        const container = document.createElement('div'); container.className = 'document-preview-page';
        container.append(canvas); host.append(container);
        renderTask = page.render({canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0]});
        await renderTask.promise; renderTask = null;
        page.cleanup();
      }
      if (version !== sequence) return;
      status.remove(); host.dataset.ready = 'true'; send().disabled = false;
    } catch (error) {
      if (version !== sequence) return;
      host.replaceChildren(status);
      status.textContent = 'The preview could not load. Please try again before sending.';
      const retry = document.createElement('button'); retry.className = 'ghost'; retry.textContent = 'Retry preview';
      retry.onclick = () => show(currentFile); host.append(retry);
      console.warn('Document preview could not render:', error.message);
    }
  }
  window.nakiDocumentPreview = {show, clear};
  window.addEventListener('pagehide', clear);
})();
