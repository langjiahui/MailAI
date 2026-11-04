const {revealItem,selectTab}=require('./companion-ui.cjs');
async function settled(dialog){await dialog.page().waitForFunction(()=>document.querySelector('#companion-growth-dialog')?.getAttribute('aria-busy')==='false');}
async function selectItem(dialog,id){await revealItem(dialog,id);const owned=dialog.locator(`.pet-shop [data-pet-item-action="${id}"]`);if(await owned.count()){await owned.click();await settled(dialog);}else await dialog.locator(`.pet-shop [data-pet-preview="${id}"]`).click();}
async function redeemItem(dialog,id){await selectItem(dialog,id);await dialog.locator(`[data-pet-purchase-open="${id}"]`).click();const response=dialog.page().waitForResponse(r=>r.url().endsWith('/api/companion/purchase')&&r.request().method()==='POST');await dialog.locator(`[data-pet-buy="${id}"]`).click();const result=await (await response).json();await settled(dialog);return result;}
async function removeItem(dialog,id){await selectItem(dialog,id);await dialog.locator(`.pet-backpack-detail [data-pet-item-action="${id}"]`).click();await settled(dialog);}
async function openStageFitting(dialog){await selectTab(dialog,'journey');await dialog.locator('.pet-journey article:not([hidden]) [data-pet-try-stage]').click();}
module.exports={selectItem,redeemItem,removeItem,settled,openStageFitting};
