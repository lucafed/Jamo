document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('jamoProposalForm');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const place = document.getElementById('jamoPlaceName').value.trim();
    const area = document.getElementById('jamoPlaceArea').value.trim();
    const why = document.getElementById('jamoPlaceWhy').value.trim();
    const proposal = `Proposta Tesoro Jamo\nLuogo: ${place}\nLocalità: ${area}\nPerché è speciale: ${why}`;
    const status = document.getElementById('jamoProposalNote');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard non disponibile');
      await navigator.clipboard.writeText(proposal);
      status.textContent = 'Proposta copiata! Conservala: l’invio alla redazione non è ancora attivo.';
    } catch {
      const blob = new Blob([proposal], {type:'text/plain;charset=utf-8'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'proposta-tesoro-jamo.txt'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = 'Proposta salvata in un file di testo. L’invio alla redazione non è ancora attivo.';
    }
  });
});
