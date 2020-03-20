const dotenv = require('dotenv');
dotenv.config();

module.exports = function() {
    const storeHash = process.env.STORE;

    const bcHeaders = {
        'X-Auth-Token': process.env.TOKEN,
        'X-Auth-Client': process.env.CLIENT,
        'Accepts': 'application/json'
    }
    return {
        baseURL: `https://api.bigcommerce.com/stores/${storeHash}/`,
        headers: bcHeaders
    }
}
