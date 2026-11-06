import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPerks, progressInterval } from '../lib/affectionRules.js';
import { detailPayload, overviewPayload, noSoulmatePayload, confirmationPayload, affectionFeedback } from '../lib/affectionPresentation.js';

const detail = { characterId: 'a', name: 'Marin Kitagawa', franchises: ['My Dress-Up Darling'],
  image: 'https://example.com/portrait.png', total: 640, isOwned: true, isSoulmate: true,
  interval: { previous: 600, next: 700, progress: 40, required: 100, remaining: 60,
    rewards: [{ label: 'Negation 8%' }, { label: 'six-minute claim-wait contribution' }] },
  normalContribution: { rollBonus: 1, claimReductionMs: 0 },
  benefits: { perks: { windfall: 10, itemConservation: 16, unbrokenBond: 16,
    claimConservation: 8, fortunesFavor: 8, negation: 0, echo: 0 } } };

test('roll feedback groups actual gains by player and character without inventing Bond or duplicate unlocks', () => {
  const milestone={key:'normal_25',itemId:'four_leaf_clover'};
  const text=affectionFeedback([
    {userId:'101',characterId:'soul',name:'Marin',amount:5,base:5,milestones:[milestone]},
    {userId:'202',characterId:'rolled',amount:20,base:20,milestones:[]},
    {userId:'101',characterId:'soul',name:'Marin',amount:8,base:8,milestones:[milestone]},
  ],'rolled',{showPlayer:true});
  assert.equal(text,'<@101> · **Marin**\n❤️ **+13** affection\n🔓 **1 item reward** unlocked\n\n<@202>\n❤️ **+20** affection');
});

test('feedback keeps different characters and users separate and retains genuine Bond labels',()=>{
  const text=affectionFeedback([
    {userId:'101',characterId:'a',name:'Old soulmate',amount:5,base:5,milestones:[]},
    {userId:'101',characterId:'b',name:'New *soulmate* @everyone',amount:16,base:8,milestones:[]},
    {userId:'202',characterId:'a',name:'Old soulmate',amount:3,base:8,milestones:[]},
  ],'rolled',{showPlayer:true});
  assert.match(text,/\+5/);assert.match(text,/\+16/);assert.match(text,/\+3/);
  assert.equal((text.match(/Unbroken Bond/g)||[]).length,1);
  assert.match(text,/<@202>/);assert.doesNotMatch(text,/@everyone/);
  assert.ok(text.indexOf('Old soulmate')<text.indexOf('New'));
});

test('earning feedback separates item rewards, normal passives and soulmate checkpoint upgrades', () => {
  const text = affectionFeedback([{userId:'101',characterId:'a',amount:100,base:100,
    milestones:[{tier:'rare'},{rollBonus:1},{claimReductionMs:360000}],
    checkpoints:[{threshold:150,effect:'item_conservation',chance:.08},{threshold:250,effect:'windfall',chance:.10}]}],'a');
  assert.equal(text, '❤️ **+100** affection\n🔓 **1 item reward** unlocked\n🔓 **+1 hourly roll** unlocked\n🔓 **6-minute claim cooldown reduction** unlocked\n🔓 **Item Conservation · 8%** unlocked\n🔓 **Windfall · 10%** upgraded');
  assert.equal(affectionFeedback([{userId:'101',characterId:'a',amount:40,base:20,milestones:[]}],'a'),
    '❤️ **+40** affection · Unbroken Bond');
  assert.equal(affectionFeedback([{characterId:'a',amount:0,milestones:[]}],'a'),'');
});

test('active soulmate uses gold, original portrait, interval meter and expanded perks', () => {
  const payload = detailPayload(detail, { ownerName: 'Neb', prefix: '?', isSelf: true });
  const embed = payload.embeds[0].toJSON();
  const text = JSON.stringify(embed);
  assert.equal(embed.color, 0xF2C66D);
  assert.equal(embed.thumbnail.url, 'https://example.com/portrait.png');
  assert.match(text, /40 \/ 100/);
  assert.match(text, /Negation 8% \+ six-minute claim-wait contribution/);
  assert.match(text, /Windfall · 10% — spend no roll/);
  assert.doesNotMatch(text, /to go|to next reward|0 min/);
  assert.match(embed.footer.text, /\?aff/);
  assert.doesNotMatch(text, /Currently owned|perks active|level|reward path/i);
  assert.equal(payload.flags, undefined);
  assert.deepEqual(payload.components, []);
});

test('core rule projections render union ties only for the selected soulmate and normal milestones otherwise', () => {
  const selected = detailPayload({ ...detail, interval: progressInterval(640, { soulmate: true }),
    benefits: { perks: getPerks(640) } }, { ownerName: 'Neb', prefix: '?' });
  assert.match(JSON.stringify(selected), /Negation 8% \+ six-minute claim-wait contribution/);
  assert.match(JSON.stringify(selected), /Windfall · 10%/);
  assert.match(JSON.stringify(selected), /Item Conservation · 16%/);
  const normal = detailPayload({ ...detail, total: 820, isSoulmate: false, interval: progressInterval(820) },
    { ownerName: 'Neb', prefix: '?' });
  assert.match(JSON.stringify(normal), /Franchise Passport/);
  assert.match(JSON.stringify(normal), /20 \/ 100/);
  assert.doesNotMatch(JSON.stringify(normal), /Echo|Negation|Windfall/);
});

test('regular, former, public and capped cards hide inactive soulmate details', () => {
  const regular = { ...detail, name: 'Rem', total: 820, isSoulmate: false,
    interval: { previous: 800, next: 900, progress: 20, required: 100, remaining: 80,
      rewards: [{ label: 'Franchise Passport' }] } };
  const owned = detailPayload(regular, { ownerName: 'Neb', prefix: '?', isSelf: true }).embeds[0].toJSON();
  assert.equal(owned.color, 0xE91E63);
  assert.match(JSON.stringify(owned), /♥ 820/);
  assert.match(owned.footer.text, /\?sm Rem/);
  assert.doesNotMatch(JSON.stringify(owned), /Soulmate perks|Windfall|inactive soulmate/i);
  const former = detailPayload({ ...regular, isOwned: false, isFormer: true, image: null },
    { ownerName: 'Other', prefix: '?', isSelf: false }).embeds[0].toJSON();
  assert.match(former.description, /Former ownership · saved progress/);
  assert.match(JSON.stringify(former), /Inactive — requires current ownership/);
  assert.doesNotMatch(former.footer.text, /to select/);
  assert.equal(former.thumbnail, undefined);
  const cap = detailPayload({ ...regular, total: 2100, interval: { next: null } },
    { ownerName: 'Neb', prefix: '?' }).embeds[0].toJSON();
  assert.match(cap.fields.find(field=>field.name==='Affection').value, /♥ 2,100\nAll current rewards unlocked/);
  assert.ok(!cap.fields.some(field => field.name.startsWith('Next')));
  assert.doesNotMatch(JSON.stringify(cap), /0 \/ 0/);
});

test('overview separates whole-harem benefits from five compact relationships and fixed navigation', () => {
  const view = { rows: Array.from({ length: 5 }, (_, i) => ({ ...detail, characterId: `${i}`, name: `Name ${i}` })),
    page: 0, pages: 2, total: 8, former: false, hasFormer: true,
    benefits: { rollBonus: 4, claimReductionMs: 720000, soulmate: { name: 'Marin', total: 640 } },
    pending: { owed: 0, pending: 0 } };
  const result = overviewPayload(view, { ownerName: 'Neb', prefix: '?' });
  const embed = result.embeds[0].toJSON();
  assert.equal(embed.color, 0xE91E63);
  assert.match(JSON.stringify(embed), /\+4 hourly rolls/);
  assert.match(JSON.stringify(embed), /12 min less claim waiting/);
  assert.equal(embed.fields.filter(field => /Name \d/.test(field.name)).length, 5);
  assert.match(embed.footer.text, /Page 1 of 2 · 8 owned · \?aff/);
  assert.doesNotMatch(JSON.stringify(embed), /highest affection first|cap|level/i);
  assert.doesNotMatch(JSON.stringify(embed), /to go|Pending item rewards/);
  const buttons = result.components[0].toJSON().components;
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, false);
  assert.equal(buttons[2].label, 'Former characters');
  assert.ok(buttons.every(button => button.custom_id.startsWith('affection:')));
});

test('empty states and confirmation use dynamic prefix and no invented progress', () => {
  const emptyOverview=overviewPayload({rows:[],benefits:{},pending:{}},{ownerName:'Neb',prefix:'~'}).embeds[0].toJSON();
  assert.ok(!emptyOverview.fields.some(field=>['Normal harem bonuses','Pending item rewards'].includes(field.name)));
  const emptyDetail=detailPayload({...detail,isSoulmate:false,normalContribution:{}},{ownerName:'Neb',prefix:'~'}).embeds[0].toJSON();
  assert.ok(!emptyDetail.fields.some(field=>field.name==='Normal bonuses'));
  const none = noSoulmatePayload({ ownerName: 'Neb', prefix: '~', isSelf: true });
  assert.match(JSON.stringify(none), /No soulmate selected/);
  assert.match(JSON.stringify(none), /~soulmate/);
  assert.doesNotMatch(JSON.stringify(none), /▰|▱/);
  const confirmation = confirmationPayload(detail);
  assert.match(JSON.stringify(confirmation), /12-hour/);
  assert.match(JSON.stringify(confirmation), /640/);
  assert.doesNotMatch(JSON.stringify(confirmation), /checked again|availability/);
  assert.equal(confirmation.components[0].toJSON().components[0].custom_id, 'soulmate:confirm');
});

test('maximal Unicode text stays within native embed budgets without broken surrogates or pings', () => {
  const huge = '😀界*_@everyone'.repeat(1000);
  for (const result of [detailPayload({ ...detail, name: huge, franchises: [huge] },
    { ownerName: huge, prefix: huge, isSelf: true }),
  overviewPayload({ rows: Array.from({ length: 5 }, () => ({ ...detail, name: huge,
    interval: { ...detail.interval, rewards: [{ label: huge }] } })),
    page: 0, pages: 1, total: 5, benefits: {} }, { ownerName: huge, prefix: huge })]) {
    const embed = result.embeds[0].toJSON();
    const strings = [embed.title, embed.description, embed.author?.name, embed.footer?.text,
      ...(embed.fields ?? []).flatMap(field => [field.name, field.value])].filter(Boolean);
    assert.ok(strings.reduce((n, s) => n + s.length, 0) <= 6000);
    assert.ok((embed.title?.length ?? 0) <= 256);
    assert.ok((embed.author?.name.length ?? 0) <= 256);
    assert.ok(embed.fields.every(field => field.name.length <= 256 && field.value.length <= 1024));
    assert.ok(strings.every(s => !/[\uD800-\uDFFF]/u.test(s)));
    assert.deepEqual(result.allowedMentions.parse, []);
  }
});
