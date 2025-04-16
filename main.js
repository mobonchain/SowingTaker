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
    log('Không tìm thấy proxy trong proxy.txt. Chạy không dùng proxy.', 'warning');
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
                log(`Private key ${i + 1} không hợp lệ: ${error.message}`, 'error');
                return null;
            }
        })
        .filter(wallet => wallet)
    : [];
if (wallets.length === 0) {
    throw new Error('Không tìm thấy private key hợp lệ trong wallet.txt'.red);
}

if (proxies.length < wallets.length) {
    log(`Cảnh báo: Chỉ có ${proxies.length} proxy cho ${wallets.length} ví. Một số ví sẽ không dùng proxy.`, 'warning');
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
            colored = `${message}`.white;
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
    const port = url.port || '80';
    return `${url.hostname}:${port}`.yellow;
}

function read_log_json() {
    try {
        if (fs.existsSync('log.json')) {
            return JSON.parse(fs.readFileSync('log.json', 'utf-8'));
        }
        return {};
    } catch (error) {
        return {};
    }
}

function write_log_json(data) {
    try {
        fs.writeFileSync('log.json', JSON.stringify(data, null, 2));
    } catch (error) {
        log(`Lỗi ghi log.json: ${error.message}`, 'error');
    }
}

function format_time(timestamp) {
    const time_left = timestamp - Date.now();
    if (time_left <= 0) return 'Đủ điều kiện';
    const hours = Math.floor(time_left / (1000 * 60 * 60));
    const minutes = Math.floor((time_left % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((time_left % (1000 * 60)) / 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
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
    if (response.code === 200) {
        const log_data = read_log_json();
        log_data[wallet.address] = { nextTimestamp: response.result.nextTimestamp || null };
        write_log_json(log_data);
        return response.result;
    }
    throw new Error('Không lấy được thông tin user: ' + response.message);
}

async function sign_in(wallet, token) {
    const response = await api_request(`${api}/task/signIn?status=true`, 'GET', null, token, wallet.proxy);
    if (response.code === 200) {
        log('Bắt đầu farming thành công', 'success');
        return true;
    }
    log('Bắt đầu farming thất bại: ' + response.message, 'error');
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

        log('Nhận thưởng thành công', 'success');
        return true;
    } catch (error) {
        log(`Lỗi nhận thưởng: ${error.message}`, 'error');
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

async function check_and_process_wallet(wallet, token, is_initial = false) {
    const log_data = read_log_json();
    const wallet_log = log_data[wallet.address];
    const now = Date.now();

    if (is_initial) {
        if (!wallet_log || !wallet_log.nextTimestamp || wallet_log.nextTimestamp <= now) {
            log('Ví sẵn sàng farming', 'info');
        } else {
            log(`Ví đang chờ: ${format_time(wallet_log.nextTimestamp)}`, 'info');
            return;
        }
    } else if (wallet_log && wallet_log.nextTimestamp && wallet_log.nextTimestamp > now) {
        return;
    }

    try {
        const user_info = await get_user_info(wallet, token);
        if (user_info.nextTimestamp && user_info.nextTimestamp <= now) {
            log('Chu kỳ farming hoàn tất. Nhận thưởng...', 'info');
            await farm_cycle(wallet, token);
        } else if (!user_info.nextTimestamp) {
            log('Bắt đầu farming...', 'info');
            await sign_in(wallet, token);
        }
    } catch (error) {
        log(`Lỗi kiểm tra farming: ${error.message}`, 'error');
    }
}

async function run() {
    log(`Khởi động Taker Farming Bot cho ${wallets.length} ví`, 'success');

    for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        log(`Xử lý ví ${i + 1}/${wallets.length}`, 'info');
        log(`Proxy: ${get_proxy_host(wallet.proxy)}`, 'info');
        try {
            const nonce = await get_nonce(wallet);
            const token = await login(wallet, nonce);
            tokens[wallet.address] = token;
            log('Đăng nhập thành công', 'success');
            await check_and_process_wallet(wallet, token, true);
        } catch (error) {
            log(`Lỗi: ${error.message}`, 'error');
        }
    }

    if (Object.keys(tokens).length === 0) {
        log('Không có ví nào đăng nhập được. Thoát...', 'error');
        return;
    }

    setInterval(async () => {
        for (let i = 0; i < wallets.length; i++) {
            const wallet = wallets[i];
            const token = tokens[wallet.address];
            if (token) {
                await check_and_process_wallet(wallet, token);
            }
        }
    }, 10800000);
}

run();
