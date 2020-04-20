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
    const csvStream = csv.format({ headers: true });
    csvStream.pipe(writableStream);

    // Put the CSV filename here
    fs.createReadStream('./example.csv')
        .pipe(csv.parse({ headers: true }))
        .on('error', error => console.error(error))
        .on('data', row => customerArray.push({
            customerId: row['Merchant User ID'],
            email: '',
            orderId: 0,
            dateCreated: '',
            transactionId: '',
            storedInstruments: 0,
            paypalVaulted: false,
            address: 'No Shipping Address'
        }))
        .on('end', () => checkOrders(customerArray, 0));

    function checkOrders(customers, counter) {
        let endCounter = counter + 100;

        if (customers.length <= counter) {
            console.log(`Counter is at ${counter}. Total customers is ${customers.length}`);
            // Here is where to shift to the next phase after orders have been identified
            if (process.env.PAYMENT == 'true') {
                return checkPaymentMethods(customerArray, 0)
            } else {
                return writeToCSV(customers)
            }

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
        // Check for non-integer values passed as customer id
        if (customerId * 0 !== 0) {
            console.log('cust id was not a number', customerId);
            return false;
        }
        return axios.get(`v2/orders?customer_id=${customerId}&status_id=0&sort=date_created:desc&limit=1`, { validateStatus: () => true });
    }

    function identifyIncompleteOrders(requests, counter) {
        // First clear requests array of any non-requests
        const filteredRequests = requests.filter(req => req !== false);

        axios.all(filteredRequests)
            .then(axios.spread((...responses) => {
                responses.forEach(response => filterOrderResponse(response))
            }))
            .then(() => {
                //Wait a sec
                setTimeout(checkOrders, 1000, customerArray, counter);
            })
            .catch(err => {
                if (!err.response) {
                    console.log("Network error, trying again")
                };
                setTimeout(identifyIncompleteOrders, 1000, requests, counter);
            })
    }

    function filterOrderResponse(response) {
        if (response.status === 200) {
            if (response.data[0]) {
                const responseData = response.data[0];
                associateOrderWithCustomer(responseData);
            } else {
                console.log('Unusual response data:', response.data)
            }
        } else {
            console.log(response.status);
        }
    }

    function associateOrderWithCustomer(responseData) {
        for (i = 0; i < customerArray.length; i++) {
            if (parseInt(customerArray[i].customerId) === responseData.customer_id) {
                customerArray[i].orderId = responseData.id;
                customerArray[i].transactionId = responseData.payment_provider_id;
                customerArray[i].dateCreated = responseData.date_created;
            }
        }
    }

    // Similar pattern as checkOrders()
    // iterate over customers order IDs and pull payment methods
    function checkPaymentMethods(customers, counter) {
        let endCounter = counter + 100;

        if (customers.length <= counter) {
            // Check option to pull addresses, otherwise write to CSV and exit
            if (process.env.ADDRESS == 'true') {
                checkAddresses(customers, 0);
            } else {
                writeToCSV(customers);
            }

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
            .then(() => {
                // Wait a sec before next batch of orders
                setTimeout(checkPaymentMethods, 1000, customerArray, counter);
            })
            .catch(err => {
                if (!err.response) {
                    console.log("Network error, trying again")
                };
                setTimeout(identifyStoredInstruments, 1000, requests, counter);
            });
    }

    function filterPaymentMethod(response) {
        if (response.status === 200) {
            const param = '?order_id=';
            const i = response.config.url.indexOf('?order_id=');
            const orderId = parseInt(response.config.url.slice(i + param.length));
            // Determine if the customer has PayPal vaulted
            let paypalPresent = checkPaypal(response.data['data']);
            // Sum total stored payments for customer
            let methodsLength = response.data['data'].map(method => {
                return method.stored_instruments.length;
            });
            const totalInstruments = methodsLength.reduce((total, num) => total += num);
            assignInstrumentCountsToCustomer(totalInstruments, orderId, paypalPresent);
        } else {
            console.log(response.status)
        }
    }

    function assignInstrumentCountsToCustomer(totalInstruments, orderId, paypal) {
        for (i = 0; i < customerArray.length; i++) {
            if (customerArray[i].orderId === orderId) {
                customerArray[i].storedInstruments = totalInstruments;
                customerArray[i].paypalVaulted = paypal;
            }
        }
    }

    function checkPaypal(methods) {
        // check length of stored_instruments on methods with id braintree.paypal
        let payPal = false;
        methods.forEach(method => {
            if (method.id === 'braintree.paypal' && method.stored_instruments.length > 0) {
                console.log('paypal is present')
                payPal = true;
            }
        })
        return payPal;
    }

    // Get all shipping addresses for inclusion in the CSV
    function checkAddresses(customers, counter) {
        let endCounter = counter + 100;

        if (customers.length <= counter) {
            // Check option to pull emails, otherwise write to CSV and exit
            if (process.env.EMAIL == 'true') {
                checkEmails(customers, 0);
            } else {
                writeToCSV(customers);
            }
        }
        if (endCounter > customers.length) {
            endCounter = customers.length;
        }

        let segment = [counter, endCounter];

        let customerAddressRequestArray = [];
        console.log('check address batch', segment);
        for (i = segment[0]; i < segment[1]; i++) {
            if (!customers[i].orderId) {
                customers[i].orderId = 0;
            }
            customerAddressRequestArray.push(getCustomerAddress(customers[i].customerId));
            // When loop is done populating with axios requests, start filtering them
            if (customerAddressRequestArray.length === segment[1] - segment[0]) {
                requestCustomerAddresses(customerAddressRequestArray, endCounter);
            }
        }
    }

    function getCustomerAddress(customerId) {
        if (customerId * 0 !== 0) {
            console.log('cust id was not a number', customerId);
            return false;
        }
        return axios.get(`v2/customers/${customerId}/addresses`, { validateStatus: () => true });
    }

    function requestCustomerAddresses(requests, counter) {
        // First clear requests array of any non-requests
        const filteredRequests = requests.filter(req => req !== false);
        const idRegex = /\/customers\/(\d+)/;
        axios.all(filteredRequests)
            .then(axios.spread((...responses) => {
                responses.forEach(response => {
                    if (response.status === 200) {
                        const url = response.config.url;
                        const customerId = url.match(idRegex)[1];
                        const address = response.data;
                        console.log('cust ID regexed to:', customerId);
                        applyAddressToCustomer(customerId, address);
                    } else {
                        console.log(response.status);
                    }
                })
            }))
            .then(() => {
                // Wait a sec before next batch of orders
                setTimeout(checkAddresses, 1000, customerArray, counter);
            })
            .catch(err => {
                if (!err.response) {
                    console.log("Network error, trying again")
                };
                setTimeout(requestCustomerAddresses, 1000, requests, counter);
            });
    }

    function applyAddressToCustomer(customerId, address) {
        for (i = 0; i < customerArray.length; i++) {
            if (customerArray[i].customerId === customerId) {
                customerArray[i].address = JSON.stringify(address);
            }
        }
    }

    // Get all customer email addresses for inclusion in the CSV
    function checkEmails(customers, counter) {
        let endCounter = counter + 100;

        if (customers.length <= counter) {
            //kick off function to write results to csv
            writeToCSV(customers);
        }
        if (endCounter > customers.length) {
            endCounter = customers.length;
        }

        let segment = [counter, endCounter];

        let customerEmailRequestArray = [];
        console.log('check email batch', segment);
        for (i = segment[0]; i < segment[1]; i++) {
            customerEmailRequestArray.push(getCustomerEmail(customers[i].customerId));
            // When loop is done populating with axios requests, start filtering them
            if (customerEmailRequestArray.length === segment[1] - segment[0]) {
                requestCustomerEmailBatch(customerEmailRequestArray, endCounter);
            }
        }
    }

    function getCustomerEmail(customerId) {
        if (customerId * 0 !== 0) {
            console.log('cust id was not a number', customerId);
            return false;
        }
        return axios.get(`v2/customers/${customerId}`, { validateStatus: () => true });
    }

    function requestCustomerEmailBatch(requests, counter) {
        // First clear requests array of any non-requests
        const filteredRequests = requests.filter(req => req !== false);
        const idRegex = /\/customers\/(\d+)/;
        axios.all(filteredRequests)
            .then(axios.spread((...responses) => {
                responses.forEach(response => {
                    if (response.status === 200) {
                        const url = response.config.url;
                        const customerId = url.match(idRegex)[1];
                        const email = response.data.email;
                        console.log('cust ID regexed to:', customerId);
                        applyEmailToCustomer(customerId, email);
                    } else {
                        console.log(response.status);
                    }
                })
            }))
            .then(() => {
                // Wait a sec before next batch of orders
                setTimeout(checkEmails, 1000, customerArray, counter);
            })
            .catch(err => {
                if (!err.response) {
                    console.log("Network error, trying again")
                };
                setTimeout(requestCustomerEmailBatch, 1000, requests, counter);
            });
    }

    function applyEmailToCustomer(customerId, email) {
        for (i = 0; i < customerArray.length; i++) {
            if (customerArray[i].customerId === customerId) {
                customerArray[i].email = email;
            }
        }
    }

    function formatForCSV(customer) {
        const orderId = customer.orderId === 0 ? 'No incomplete orders' : customer.orderId;
        const storedInstruments = customer.storedInstruments === 0 ? 'No saved payments' : customer.storedInstruments;
        return {
            'BC Customer ID': customer.customerId,
            'BC Customer Email': customer.email,
            'BC Order ID': orderId,
            'BC Order Transaction ID': customer.transactionId,
            'BC Order Date': customer.dateCreated,
            'Saved Instrument Count': storedInstruments,
            'PayPal Saved': customer.paypalVaulted,
            'Shipping Address': customer.address
        }
    }

    function writeToCSV(customers) {
        customers.forEach(customer => {
            csvStream.write(formatForCSV(customer));
        });
        console.log('did it?')
    }
}());
