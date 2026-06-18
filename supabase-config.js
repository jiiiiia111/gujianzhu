/**
 * Supabase 云端数据库配置
 * 
 * 功能：
 * 1. 初始化 Supabase 客户端
 * 2. 云端读取/保存问答数据
 * 3. 页面加载时自动同步云端数据到本地
 */

// ===== 配置区 =====
const SUPABASE_URL = 'https://wqtjahycvohgnuygvigp.supabase.co';
// 请在 Supabase 项目 Settings > API 中找到 anon public key 并替换下面这行
const SUPABASE_ANON_KEY = 'sb_publishable_q8TVrf66SPBKotRZJvmRlw_crP8GvKR';
// ==================

var supabaseClient = null;
var supabaseAvailable = false;

// 初始化 Supabase 客户端
(function initSupabase() {
     if (SUPABASE_ANON_KEY === 'YOUR_ANON_KEY_HERE') {
        console.warn('⚠️ Supabase anon key 未配置，云端同步不可用。请在 supabase-config.js 中填写你的 anon key。');
        return;
    }
    try {
        if (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function') {
            supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            supabaseAvailable = true;
            console.log('✅ Supabase 云端数据库已连接');
        } else {
            console.warn('⚠️ Supabase SDK 未加载，请确保页面引入了 supabase-js CDN');
        }
    } catch (e) {
        console.error('❌ Supabase 初始化失败:', e);
    }
})();

/**
 * 从云端加载所有问答数据
 * @returns {Promise<Array>} [{question, answer, created_at}, ...]
 */
async function supabaseLoadAllQA() {
    if (!supabaseAvailable || !supabaseClient) {
        console.warn('云端不可用，跳过加载');
        return [];
    }
    try {
        var result = await supabaseClient.from('chatbot_qa').select('*').order('created_at', { ascending: false });
        if (result.error) throw result.error;
        console.log('☁️ 从云端加载了 ' + result.data.length + ' 条问答');
        return result.data || [];
    } catch (e) {
        console.warn('从云端加载失败:', e.message || e);
        return [];
    }
}

/**
 * 保存/更新一条问答到云端
 * @param {string} question - 问题
 * @param {string} answer - 答案
 * @returns {Promise<boolean>}
 */
async function supabaseSaveQA(question, answer) {
    if (!supabaseAvailable || !supabaseClient) return false;
    if (!question || !answer) return false;

    try {
        // 先查是否已存在
        var checkResult = await supabaseClient.from('chatbot_qa').select('id').eq('question', question.trim());
        
        if (checkResult.data && checkResult.data.length > 0) {
            // 已存在，更新
            await supabaseClient.from('chatbot_qa').update({ answer: answer.trim() }).eq('question', question.trim());
            console.log('☁️ 云端已更新:', question.trim());
        } else {
            // 插入新记录
            await supabaseClient.from('chatbot_qa').insert([{ question: question.trim(), answer: answer.trim() }]);
            console.log('☁️ 云端已新增:', question.trim());
        }
        return true;
    } catch (e) {
        console.warn('云端保存失败（本地数据仍保留）:', e.message || e);
        return false;
    }
}

/**
 * 批量同步本地数据到云端（页面加载时调用）
 * 将 localStorage 中的数据合并到 Supabase
 */
async function supabaseSyncLocalToCloud() {
    if (!supabaseAvailable || !supabaseClient) return;

    try {
        // 读取本地数据
        var localRaw = localStorage.getItem('chatbot_user_learned');
        if (!localRaw) return;
        
        var localData;
        try { localData = JSON.parse(localRaw); } catch(e) { return; }
        if (!localData || localData.length === 0) return;

        console.log('🔄 正在同步 ' + localData.length + ' 条本地数据到云端...');

        // 从云端加载现有数据（用于去重）
        var cloudResult = await supabaseClient.from('chatbot_qa').select('question');
        var cloudQuestions = new Set();
        if (cloudResult.data) {
            cloudResult.data.forEach(function(item) { cloudQuestions.add(item.question); });
        }

        var syncedCount = 0;
        for (var i = 0; i < localData.length; i++) {
            var entry = localData[i];
            if (Array.isArray(entry) && entry.length >= 2) {
                var q = entry[0], a = entry[1];
                if (!cloudQuestions.has(q)) {
                    await supabaseSaveQA(q, a);
                    syncedCount++;
                }
            }
        }
        if (syncedCount > 0) {
            console.log('✅ 已同步 ' + syncedCount + ' 条新数据到云端');
        }
    } catch (e) {
        console.warn('批量同步失败:', e.message || e);
    }
}

/**
 * 删除云端的一条问答
 * @param {string} question - 要删除的问题
 */
async function supabaseDeleteQA(question) {
    if (!supabaseAvailable || !supabaseClient) return false;
    if (!question) return false;
    try {
        await supabaseClient.from('chatbot_qa').delete().eq('question', question.trim());
        console.log('🗑️ 已从云端删除:', question.trim());
        return true;
    } catch (e) {
        console.warn('云端删除失败:', e.message || e);
        return false;
    }
}

/**
 * 判断答案是否为垃圾内容
 */
function _isCloudGarbageAnswer(answer) {
    if (!answer) return true;
    var garbagePatterns = [
        '微软', 'Microsoft', 'microsoft', '年报', 'Annual Report', 'annual report',
        'NASDAQ', 'nasdaq', 'SEC', 'Form 10-K', '10-K', '财年',
        'fiscal year', 'Fiscal Year', '董事会', 'Board of Directors', '股东',
        'shareholder', 'Shareholder', 'Stock', 'stock', 'NYSE', 'nyse',
        'investor', 'Investor', '披露', 'disclosure', '合规', 'compliance',
        '收入', 'revenue', 'Revenue', '利润表', '资产负债表', '现金流量',
        'LinkedIn', 'linkedin', 'GitHub', 'github', '社招', '校招', '招聘'
    ];
    for (var gi = 0; gi < garbagePatterns.length; gi++) {
        if (answer.indexOf(garbagePatterns[gi]) !== -1) return true;
    }
    return false;
}

/**
 * 页面加载时：从云端加载数据并合并到 localStorage
 * 在任何页面初始化时调用此函数
 */
async function loadCloudData() {
    if (!supabaseAvailable || !supabaseClient) return;

    try {
        console.log('🔍 正在检查云端数据...');
        var cloudData = await supabaseLoadAllQA();
        if (!cloudData || cloudData.length === 0) return;

        // 读取本地数据
        var localRaw = localStorage.getItem('chatbot_user_learned');
        var localData = localRaw ? JSON.parse(localRaw) : [];
        
        // 合并去重：云端有但本地没有的 → 加入本地（但要先过滤垃圾内容）
        var localQuestions = new Set();
        localData.forEach(function(entry) {
            if (Array.isArray(entry) && entry.length >= 1) {
                localQuestions.add(entry[0]);
            }
        });

        var mergedCount = 0;
        var deletedCount = 0;
        for (var i = 0; i < cloudData.length; i++) {
            var item = cloudData[i];
            // 检测垃圾内容
            if (_isCloudGarbageAnswer(item.answer)) {
                console.warn('[云端过滤] 检测到垃圾内容，跳过并删除:', item.question);
                supabaseDeleteQA(item.question);
                deletedCount++;
                continue;
            }
            if (!localQuestions.has(item.question)) {
                localData.push([item.question, item.answer]);
                mergedCount++;
            }
        }

        if (mergedCount > 0) {
            localStorage.setItem('chatbot_user_learned', JSON.stringify(localData));
            console.log('✅ 从云端合并了 ' + mergedCount + ' 条新知识到本地');
        } else {
            console.log('✅ 云端数据已是最新，无需合并');
        }
        if (deletedCount > 0) {
            console.log('🗑️ 从云端删除了 ' + deletedCount + ' 条垃圾数据');
        }
    } catch (e) {
        console.warn('加载云端数据失败:', e.message || e);
    }
}
