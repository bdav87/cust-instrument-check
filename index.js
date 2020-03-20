const axios = require('axios').default;
const fs = require('fs');
const csv = require('fast-csv');
const bcConfig = require('./lib/bc-config');

const bc = bcConfig();
axios.defaults.headers.common['X-Auth-Token'] = bc.headers['X-Auth-Token'];
axios.defaults.headers.common['X-Auth-Client'] = bc.headers['X-Auth-Client'];
axios.defaults.baseURL = bc.baseURL;

(function main() {
    // customerArray will populate with scanned objects representing IDs from CSV, order ID
    // and stored instrument counts.
    const customerArray = [];
    const date = new Date().toDateString().split(' ').join('_');
    const filename = `customersWithInstruments-${date}.csv`;
    const writableStream = fs.createWriteStream(filename);
    const csvStream = csv.format({headers: true});
    csvStream.pipe(writableStream);

    fs.createReadStream('./customers.csv')
        .pipe(csv.parse({ headers: true }))
        .on('error', error => console.error(error))
        .on('data', row => customerArray.push({
            customerId: parseInt(row['Merchant User ID']),
            orderId: 0,
            storedInstruments: 0
        }))
        .on('end', () => checkOrders(customerArray, 0));

    function checkOrders(customers, counter) {
        let endCounter = counter + 20;

        if (customers.length <= counter) {
            console.log(`Counter is at ${counter}. Total customers is ${customers.length}`)
            // Here is where to shift to the next phase after orders have been identified
            return checkPaymentMethods(customerArray, 0)
        }

        if (endCounter > customers.length) {
            endCounter = customers.length;
        }

        let segment = [counter, endCounter];
        let orderRequestArray = [];
        console.log('checkOrders batch', segment);
        for (i = segment[0]; i < segment[1]; i++) {
            orderRequestArray.push(getCustomerOrder(customers[i].customerId));
            // When loop is done populating with axios requests, start filtering them
            if (orderRequestArray.length === segment[1] - segment[0]) {
                identifyIncompleteOrders(orderRequestArray, endCounter);
            }
        }
    }

    function getCustomerOrder(customerId) {
        if (typeof customerId !== 'number') {
            console.log('cust id was not a number', customerId);
            return axios.get(`v2/orders?customer_id=0&status_id=0&sort=date_created:desc&limit=1`)
        }
        return axios.get(`v2/orders?customer_id=${customerId}&status_id=0&sort=date_created:desc&limit=1`)
    }

    function identifyIncompleteOrders(requests, counter) {
        axios.all(requests)
            .then(axios.spread((...responses) => {
                responses.forEach(response => filterOrderResponse(response))
            }))
            .then(() => {
                checkOrders(customerArray, counter)
            })
            .catch(err => console.error(err))
    }

    function filterOrderResponse(response) {
        if (response.status === 200) {    
            const customerId = response.data[0].customer_id;
            const orderId = response.data[0].id;
            associateOrderWithCustomer(customerId, orderId);
        }
    }

    function associateOrderWithCustomer(customerId, orderId) {
        for (i = 0; i < customerArray.length; i++) {
            if (customerArray[i].customerId === customerId) {
                customerArray[i].orderId = orderId;
            }
        }
    }

    // Similar pattern as checkOrders()
    // iterate over customers order IDs and pull payment methods
    function checkPaymentMethods(customers, counter) {
        let endCounter = counter + 10;

        if (customers.length <= counter) {
            //kick off function to write results to csv
            writeToCSV(customers);
        }
        if (endCounter > customers.length) {
            endCounter = customers.length;
        }

        let segment = [counter, endCounter];

        let paymentMethodsRequestArray = [];
        console.log('check payment methods batch', segment);
        for (i = segment[0]; i < segment[1]; i++) {
            if (!customers[i].orderId) {
                customers[i].orderId = 0;
            }
            paymentMethodsRequestArray.push(getPaymentMethods(customers[i].orderId));
            // When loop is done populating with axios requests, start filtering them
            if (paymentMethodsRequestArray.length === segment[1] - segment[0]) {
                identifyStoredInstruments(paymentMethodsRequestArray, endCounter);
            }
        }
    }


    function getPaymentMethods(orderId) {
        if (orderId === 0) {
            return false;
        }
        return axios.get(`v3/payments/methods?order_id=${orderId}`, { validateStatus: () => true });
    }

    function identifyStoredInstruments(requests, counter) {
        // First clear requests array of any non-requests
        const filteredRequests = requests.filter(req => req !== false);

        axios.all(filteredRequests)
            .then(axios.spread((...responses) => {
                responses.forEach(response => filterPaymentMethod(response))
            }))
            .then(() => checkPaymentMethods(customerArray, counter))
            .catch(err => console.log('hmm', err))
    }

    function filterPaymentMethod(response) {
        if (response.status === 200) {
            const param = '?order_id=';
            const i = response.config.url.indexOf('?order_id=');
            const orderId = parseInt(response.config.url.slice(i + param.length));
            let methods = response.data['data'].map(method => {
                return method.stored_instruments.length;
            });
            const totalInstruments = methods.reduce((total, num) => total += num);
            assignInstrumentCountsToCustomer(totalInstruments, orderId);
        } else {
            console.log(response.status)
        }
    }

    function assignInstrumentCountsToCustomer(totalInstruments, orderId) {
        for (i = 0; i < customerArray.length; i++) {
            if (customerArray[i].orderId === orderId) {
                customerArray[i].storedInstruments = totalInstruments;
            }
        }
    }

   function formatForCSV(customer) {
       const orderId = customer.orderId === 0 ? 'No incomplete orders' : customer.orderId;
       const storedInstruments = customer.storedInstruments === 0 ? 'No saved payments' : customer.storedInstruments;
       return {
           'BC Customer ID': customer.customerId,
           'BC Order ID': orderId,
           'Saved Instrument Count': storedInstruments
       }
   }

    function writeToCSV(customers) {
        customers.forEach(customer => {
            csvStream.write(formatForCSV(customer));
        });
        console.log('did it?')
    }
}());


