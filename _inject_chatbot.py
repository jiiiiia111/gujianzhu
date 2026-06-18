import re

# Read the shuzitujian page
with open(r'c:\Users\xuhui\Desktop\中国古代建筑电子博物馆\shuzitujian-数字图鉴.html', 'r', encoding='utf-8') as f:
    shuzitujian = f.read()

# Read the index page to extract chatbot HTML and JS
with open(r'c:\Users\xuhui\Desktop\中国古代建筑电子博物馆\index.html', 'r', encoding='utf-8') as f:
    index = f.read()

# Extract chatbot HTML (from '<!-- 数字人聊天机器人 -->' to '</div>\n\n<script>')
chatbot_start = index.find('<!-- 数字人聊天机器人 -->')
script_pos = index.find('\n<script>\n', chatbot_start)
if script_pos == -1:
    script_pos = index.find('<script>', chatbot_start)
chatbot_html = index[chatbot_start:script_pos].strip()

# Extract JS block (from '<script>' line to '</script>' before '<script src="qa-expanded.js">')
js_start = script_pos
qa_expanded_pos = index.find('<script src="qa-expanded.js">', js_start)
js_block = index[js_start:qa_expanded_pos].strip()

# Find </footer> in shuzitujian and insert chatbot HTML after it
footer_end = shuzitujian.find('</footer>')
if footer_end == -1:
    raise Exception('Could not find </footer>')

insert_pos = footer_end + len('</footer>')

# Insert chatbot HTML and JS
new_content = shuzitujian[:insert_pos] + '\n\n' + chatbot_html + '\n\n' + js_block + '\n<script src="qa-expanded.js"></script>\n' + shuzitujian[insert_pos:]

with open(r'c:\Users\xuhui\Desktop\中国古代建筑电子博物馆\shuzitujian-数字图鉴.html', 'w', encoding='utf-8') as f:
    f.write(new_content)

print(f'Chatbot HTML length: {len(chatbot_html)}')
print(f'JS block length: {len(js_block)}')
print(f'Total file length: {len(new_content)}')
print('Injection successful!')
