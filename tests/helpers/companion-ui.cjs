/* Reach a real paged wardrobe item through the same controls a user has. */
async function revealItem(dialog,id) {
 const back=dialog.locator('[data-pet-back-shelf]');
 if(await back.isVisible())await back.click();
 if(!await dialog.locator('.pet-shop').count())await selectTab(dialog,'wardrobe');
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
// Follow the visible space section, then its local task navigation.
async function selectTab(dialog,tab) {
 if(tab==='home')return dialog.locator('[data-pet-section="home"]').click();
 const section=['shop','wardrobe'].includes(tab)?'dress':['today','journey','history'].includes(tab)?'growth':'';
 if(section)await dialog.locator(`[data-pet-section="${section}"]`).click();
 await dialog.locator(`[data-pet-tab="${tab}"]`).click();
}
module.exports={revealItem,selectTab};
