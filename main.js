require('colors');
const axios = require('axios');
const ethers = require('ethers');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');

const api = 'https://sowing-api.taker.xyz';
const contract = '0xF929AB815E8BfB84Cdab8d1bb53F22eB1e455378';
const abi = [
    {
        "constant": false,
        "inputs": [],
        "name": "active",
        "outputs": [],
        "payable": false,
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'sec-ch-ua': '"Microsoft Edge";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'Referer': 'https://sowing.taker.xyz/',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const proxies = fs.existsSync('proxy.txt')
    ? fs.readFileSync('proxy.txt', 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
    : [];
if (proxies.length === 0) {
    console.warn('Không tìm thấy proxy trong proxy.txt. Chạy không dùng proxy.'.yellow);
}

const wallets = fs.existsSync('wallet.txt')
    ? fs.readFileSync('wallet.txt', 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map((key, i) => {
            try {
                const wallet = new ethers.Wallet(key);
                return {
                    privateKey: key,
                    address: wallet.address,
                    proxy: proxies[i] || null,
                };
            } catch (error) {
                console.error(`Private key ${i + 1} không hợp lệ: ${error.message}`.red);
                return null;
            }
        })
        .filter(wallet => wallet)
    : [];
if (wallets.length === 0) {
    throw new Error('Không tìm thấy private key hợp lệ trong wallet.txt'.red);
}

if (proxies.length < wallets.length) {
    console.warn(`Cảnh báo: Chỉ có ${proxies.length} proxy cho ${wallets.length} ví. Một số ví sẽ không dùng proxy.`.yellow);
}

const tokens = {};

function log(message, type = 'info') {
    let colored;
    switch (type) {
        case 'error':
            colored = `${message}`.red;
            break;
        case 'success':
            colored = `${message}`.green;
            break;
        case 'warning':
            colored = `${message}`.yellow;
            break;
        default:
            colored = `${message}`.cyan.bold;
    }
    console.log(colored);
}

function normalize_proxy(proxy) {
    if (!proxy) return null;
    if (!proxy.startsWith('http://') && !proxy.startsWith('https://')) {
        proxy = `http://${proxy}`;
    }
    return proxy;
}

function get_proxy_host(proxy) {
    if (!proxy) return 'Không có';
    const url = new URL(normalize_proxy(proxy));
    return `${url.hostname}:${url.port}`.yellow;
}

async function api_request(url, method = 'GET', data = null, token = null, proxy = null) {
    const config = { method, url, headers: { ...headers } };
    if (data) config.data = data;
    if (token) config.headers['authorization'] = `Bearer ${token}`;
    if (proxy) config.httpsAgent = new HttpsProxyAgent(normalize_proxy(proxy));
    try {
        const response = await axios(config);
        return response.data;
    } catch (error) {
        throw new Error(error.response?.data?.message || error.message);
    }
}

async function get_nonce(wallet) {
    const response = await api_request(
        `${api}/wallet/generateNonce`,
        'POST',
        { walletAddress: ethers.getAddress(wallet.address) },
        null,
        wallet.proxy
    );
    if (response.code === 200) {
        if (response.result?.nonce) return response.result.nonce;
        const nonceMatch = response.result?.match?.(/Nonce: (.*)$/m);
        if (nonceMatch && nonceMatch[1]) return nonceMatch[1];
    }
    throw new Error('Không tạo được nonce: ' + (response.message || 'Lỗi không xác định'));
}

async function login(wallet, nonce) {
    const address = ethers.getAddress(wallet.address);
    const message = `Taker quest needs to verify your identity to prevent unauthorized access. Please confirm your sign-in details below:\n\naddress: ${address}\n\nNonce: ${nonce}`;
    const ethers_wallet = new ethers.Wallet(wallet.privateKey);
    
    let signature;
    try {
        signature = await ethers_wallet.signMessage(message);
    } catch (error) {
        log(`Tạo chữ ký thất bại: ${error.message}`, 'error');
        throw error;
    }

    const response = await api_request(
        `${api}/wallet/login`,
        'POST',
        { address, signature, message },
        null,
        wallet.proxy
    );

    if (response.code === 200) {
        return response.result.token;
    }

    log('Chữ ký chuẩn thất bại. Thử EIP-712...', 'warning');
    const domain = { name: 'Taker', version: '1', chainId: 1125 };
    const types = { Login: [{ name: 'address', type: 'address' }, { name: 'nonce', type: 'string' }] };
    const value = { address, nonce };

    try {
        signature = await ethers_wallet.signTypedData(domain, types, value);
    } catch (error) {
        log(`Tạo chữ ký EIP-712 thất bại: ${error.message}`, 'error');
        throw error;
    }

    const eip712_response = await api_request(
        `${api}/wallet/login`,
        'POST',
        { address, signature, message: JSON.stringify({ domain, types, value }) },
        null,
        wallet.proxy
    );

    if (eip712_response.code === 200) {
        return eip712_response.result.token;
    }
    throw new Error('Đăng nhập thất bại: ' + (response.message || eip712_response.message || 'Lỗi chữ ký'));
}

async function get_user_info(wallet, token) {
    const response = await api_request(`${api}/user/info`, 'GET', null, token, wallet.proxy);
    if (response.code === 200) return response.result;
    throw new Error('Không lấy được thông tin user: ' + response.message);
}

async function sign_in(wallet, token) {
    const response = await api_request(`${api}/task/signIn?status=true`, 'GET', null, token, wallet.proxy);
    if (response.code === 200) {
        log('Đăng nhập thành công! Bắt đầu farming.', 'success');
        return true;
    }
    log('Đăng nhập thất bại: ' + response.message, 'error');
    return false;
}

async function claim_reward(wallet, token) {
    try {
        const provider = new ethers.JsonRpcProvider('https://rpc-mainnet.taker.xyz', {
            chainId: 1125,
            name: 'Taker',
            nativeCurrency: { name: 'Taker', symbol: 'TAKER', decimals: 18 }
        });
        const ethers_wallet = new ethers.Wallet(wallet.privateKey, provider);
        const contract_instance = new ethers.Contract(contract, abi, ethers_wallet);

        const tx = await contract_instance.active({
            gasLimit: 182832,
            maxPriorityFeePerGas: ethers.parseUnits('0.11', 'gwei'),
            maxFeePerGas: ethers.parseUnits('0.11135', 'gwei'),
            type: 2
        });

        log(`Gửi giao dịch: ${tx.hash}`, 'info');
        const receipt = await tx.wait();
        log(`Giao dịch xác nhận: ${receipt.hash}`, 'success');

        const sign_in_response = await api_request(`${api}/task/signIn?status=false`, 'GET', null, token, wallet.proxy);
        if (sign_in_response.code === 200) {
            log('Start Farming thành công', 'success');
        } else {
            log(`Start Farming thất bại: ${sign_in_response.message}`, 'warning');
        }

        log('Nhận thưởng thành công!', 'success');
        return true;
    } catch (error) {
        log(`Lỗi khi nhận thưởng: ${error.message}`, 'error');
        return false;
    }
}

async function farm_cycle(wallet, token) {
    try {
        const claim_success = await claim_reward(wallet, token);
        if (!claim_success) {
            return false;
        }
        return true;
    } catch (error) {
        log(`Lỗi chu kỳ farming: ${error.message}`, 'error');
        return false;
    }
}

function format_time(timestamp) {
    const time_left = timestamp - Date.now();
    if (time_left <= 0) return '00:00:00';
    const hours = Math.floor(time_left / (1000 * 60 * 60));
    const minutes = Math.floor((time_left % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((time_left % (1000 * 60)) / 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function start_countdown(wallet, token, next_timestamp) {
    if (wallet.countdown_interval) clearInterval(wallet.countdown_interval);

    const update = async () => {
        const time_left = next_timestamp - Date.now();
        if (time_left <= 0) {
            log('Chu kỳ farming hoàn tất!', 'success');
            clearInterval(wallet.countdown_interval);
            wallet.countdown_interval = null;
            await farm_cycle(wallet, token);
            return;
        }
        log(`Thời gian còn lại: ${format_time(next_timestamp)}`, 'info');
    };

    update();
    wallet.countdown_interval = setInterval(update, 60000);
}

async function process_wallets() {
    log(`Khởi động Taker Farming Bot cho ${wallets.length} ví`, 'success');
    
    for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        log(`Xử lý ví ${i + 1}/${wallets.length}`, 'info');
        log(`Proxy: ${get_proxy_host(wallet.proxy)}`, 'info');
        try {
            const nonce = await get_nonce(wallet);
            const token = await login(wallet, nonce);
            tokens[wallet.address] = token;
            log('Đăng nhập thành công!', 'success');

            const user_info = await get_user_info(wallet, token);
            log(`Điểm Taker: ${user_info.takerPoints} | Lượt đăng nhập liên tiếp: ${user_info.consecutiveSignInCount} | Số thưởng: ${user_info.rewardCount}`, 'info');

            if (user_info.nextTimestamp && user_info.nextTimestamp <= Date.now()) {
                log('Chu kỳ farming hoàn tất. Nhận thưởng...', 'info');
                await farm_cycle(wallet, token);
            } else if (user_info.nextTimestamp && user_info.nextTimestamp > Date.now()) {
                log(`Đang farming. Nhận thưởng sau: ${format_time(user_info.nextTimestamp)}`, 'info');
                start_countdown(wallet, token, user_info.nextTimestamp);
            } else {
                log('Không có farming hoạt động. Bắt đầu farming...', 'info');
                const sign_in_success = await sign_in(wallet, token);
                if (sign_in_success) {
                    const updated_info = await get_user_info(wallet, token);
                    if (updated_info.nextTimestamp) start_countdown(wallet, token, updated_info.nextTimestamp);
                }
            }
        } catch (error) {
            log(`Lỗi: ${error.message}`, 'error');
        }
    }
}

async function wait_and_restart() {
    log('Chế độ chờ 3 giờ...', 'info');
    setTimeout(async () => {
        await process_wallets();
        await wait_and_restart();
    }, 3 * 60 * 60 * 1000); // 3 giờ
}

async function run() {
    await process_wallets();
    await wait_and_restart();
}

run();
