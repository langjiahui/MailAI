/* Reach a real paged wardrobe item through the same controls a user has. */
async function revealItem(dialog,id) {
 const back=dialog.locator('[data-pet-back-shelf]');
 if(await back.isVisible())await back.click();
 if(!await dialog.locator('.pet-shop').count())await dialog.locator('[data-pet-tab="wardrobe"]').click();
 let card=dialog.locator(`.pet-shop [data-pet-item="${id}"]`);
 if(!await card.count()) {
  await dialog.locator('[data-pet-category]').selectOption('all');
  await dialog.locator('[data-pet-shop-filter="all"]').click();
  card=dialog.locator(`.pet-shop [data-pet-item="${id}"]`);
 }
 if(!await card.isVisible()) {
  const index=await card.evaluate(n=>Math.floor([...n.parentElement.children].indexOf(n)/Number(n.parentElement.dataset.pageSize)));
  await dialog.locator('[data-pet-page-select]').selectOption(String(index));
 }
 return card;
}
// Reach secondary tasks through their visible disclosure, including keyboard focus.
async function selectTab(dialog,tab) {
 const button=dialog.locator(`[data-pet-tab="${tab}"]`);
 if(!await button.isVisible())await dialog.locator('.pet-space-more>summary').click();
 await button.click();
}
module.exports={revealItem,selectTab};
