"""Date-change cues preserve evidence and never imply agreement or mutate tasks."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.conversation_changes import detect, own_text


def main():
    item=dict(source='email',id=1,sender='客户',date='2026-09-22',risky=False,current=True)
    def check(text, html=False):
        entry=dict(item,source='sent' if html else 'email')
        return detect([entry],{(entry['source'],1):{'body_html' if html else 'body_text':text}})['items']
    proposal=check('建议交付从周五改为下周二，请确认。')[0]
    assert proposal['before']=='周五' and proposal['after']=='下周二' and proposal['state']=='proposal'
    assert proposal['quote']=='建议交付从周五改为下周二，请确认。'
    assert check('双方确认将交付从9月25日调整为9月29日。')[0]['state']=='stated'
    assert check('交付改为下周二。')[0]['before']==''
    assert check('请确认能否调整为下周二交付。')[0]['state']=='proposal'
    assert check('截止日期从2026-09-25延期至2026-09-29。')[0]['state']=='unverified'
    for text in ['交付从周五改为周五。','不能将交付从周五改为下周二。','不同意将交付从周五改为下周二。',
                 '尚未确认交付从周五改为下周二。','周五交付，下周二开会。','会议从周五改为下周二。','交付从周五改为下周二，验收从周六改为下周三。',
                 '已收到。\n> 交付从周五改为下周二。','已收到。\nOn Tuesday wrote:\n交付从周五改为下周二。']:
        assert not check(text), text
    assert not check('<p>收到。</p><blockquote><p>交付从周五改为下周二。</p></blockquote>',True)
    assert not check('<p>收到。</p><div class="gmail_quote">交付从周五改为下周二。</div>',True)
    assert not check('<script>交付从周五改为下周二。</script>',True)
    assert check('<p>建议交付从周五改为下周二。</p><blockquote>过去安排</blockquote>',True)[0]['state']=='proposal'
    assert '过去安排' not in own_text({'body_html':'<p>新回复</p><blockquote>过去安排</blockquote>'},True)
    amount = check('建议总价从人民币0.10元改为人民币0.30元，请确认。')[0]
    assert amount['kind'] == 'amount' and amount['state'] == 'proposal'
    assert amount['comparison'] == '增加 0.20 CNY（按原文金额计算）'
    assert check('双方确认总价从2万元改为1.5万元。')[0]['comparison'].startswith('减少 5000.0 CNY')
    assert check('总价从USD1,000.25改为USD1,200.50。')[0]['comparison'].startswith('增加 200.25 USD')
    assert check('总价从人民币999999999999999999元改为人民币999999999999999998.99元。')[0]['comparison'].startswith('减少 0.01 CNY')
    assert check('总价从100元改为120元，均含税。')[0]['comparison'].startswith('增加 20 CNY')
    for text in ['总价从100美元改为120欧元。', '总价从100改为120。',
                 '单价从100元改为120元。', '总价从100元改为120元，税后结算。',
                 '总价从100元改为120元/件，均含税。', '总价从100元改为120元，均含税但运费另计。',
                 '总价从100元改为120元左右。']:
        assert '请核对原文' in check(text)[0]['comparison'], text
    for text in ['总价从100元改为100元。', '不同意总价从100元改为120元。',
                 '总价从100元改为120亿元。', '总价从100元改为120.12345元。',
                 '总价从100元改为120元，费用从10元改为20元。',
                 '收到。\n> 总价从100元改为120元。']:
        assert not check(text), text
    print('PASS date-change evidence, proposal/statement distinctions, unknown prior date, negation, quoted text and HTML isolation')

if __name__=='__main__': main()
