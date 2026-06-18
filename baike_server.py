from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import time
import re
from bs4 import BeautifulSoup

app = Flask(__name__)
CORS(app)  # 允许跨域请求


@app.route('/api/search', methods=['GET'])
def search_baike():
    query = request.args.get('q', '')

    if not query:
        return jsonify({'error': '请输入搜索关键词'}), 400

    try:
        # 方案1：尝试维基百科API（快速失败）
        print(f'[后端] 正在搜索: {query}')

        wiki_url = f'https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&titles={query}'

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }

        try:
            wiki_resp = requests.get(wiki_url, headers=headers, timeout=5)
            if wiki_resp.status_code == 200:
                wiki_data = wiki_resp.json()
                pages = wiki_data.get('query', {}).get('pages', {})

                for page_id, page_data in pages.items():
                    if page_id != '-1' and 'extract' in page_data:
                        content = page_data['extract']
                        if len(content) > 50:
                            print(f'[后端] 维基百科成功! 内容长度: {len(content)}')
                            return jsonify({
                                'success': True,
                                'title': page_data['title'],
                                'content': content[:1000],
                                'url': f'https://zh.wikipedia.org/wiki/{query}',
                                'length': len(content[:1000]),
                                'source': 'wikipedia'
                            })
        except:
            print('[后端] 维基百科超时，跳过')

        # 方案2：使用必应搜索API获取摘要
        print('[后端] 尝试必应搜索...')

        bing_url = f'https://cn.bing.com/search?q={query}+百度百科'

        bing_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9'
        }

        bing_resp = requests.get(bing_url, headers=bing_headers, timeout=15)

        if bing_resp.status_code == 200:
            soup = BeautifulSoup(bing_resp.text, 'html.parser')

            # 提取搜索结果摘要（先收集所有文本，再检查是否包含查询词）
            all_snippets = []
            for item in soup.find_all('p'):
                text = item.get_text(strip=True)
                if len(text) > 15:
                    all_snippets.append(text)

            # 合并所有文本后检查是否包含查询关键词
            combined = '\n'.join(all_snippets)
            # 宽松匹配：整个查询 或 查询的每个字都出现过
            query_parts = list(query)
            all_chars_found = all(ch in combined for ch in query_parts if ch.strip())
            if len(combined) > 30 and (query in combined or all_chars_found):
                content = combined[:1000]
                print(f'[后端] 必应搜索成功! 内容长度: {len(content)}')

                return jsonify({
                    'success': True,
                    'title': query,
                    'content': content,
                    'url': f'https://baike.baidu.com/item/{query}',
                    'length': len(content),
                    'source': 'bing_search'
                })

        # 所有方案都失败
        print(f'[后端] 所有数据源都失败')
        return jsonify({
            'success': False,
            'error': '无法获取内容，百度百科可能限制了访问'
        }), 500

    except requests.exceptions.Timeout:
        print('[后端] 请求超时')
        return jsonify({
            'success': False,
            'error': '请求超时，请稍后重试'
        }), 504

    except Exception as e:
        print(f'[后端] 错误: {str(e)}')
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


if __name__ == '__main__':
    print('=' * 50)
    print('🚀 百科搜索后端服务器启动中...')
    print('📡 服务地址: http://localhost:5000')
    print('🔍 API接口: http://localhost:5000/api/search?q=关键词')
    print('=' * 50)
    app.run(host='0.0.0.0', port=5000, debug=True)

