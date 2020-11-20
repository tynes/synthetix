'use strict';

const { artifacts, contract, web3 } = require('@nomiclabs/buidler');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const BN = require('bn.js');

const PublicEST = artifacts.require('PublicEST');

const {
	fastForward,
	getEthBalance,
	toUnit,
	fromUnit,
	toUnitFromBN,
	multiplyDecimal,
	currentTime,
} = require('../utils')();

const { mockGenericContractFnc, mockToken, setupAllContracts, setupContract } = require('./setup');

const {
	issueSynthsToUser,
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	setStatus,
} = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

const SafeDecimalMath = artifacts.require('SafeDecimalMath');
const CollateralManager = artifacts.require(`CollateralManager`);
const CollateralState = artifacts.require(`CollateralState`);
const ProxyERC20 = artifacts.require(`ProxyERC20`);
const TokenState = artifacts.require(`TokenState`);

contract('CollateralErc20', async accounts => {
	const MINUTE = 60;
	const DAY = 86400;
	const WEEK = 604800;
	const MONTH = 2629743;
	const YEAR = 31536000;

	const sUSD = toBytes32('sUSD');
	const sETH = toBytes32('sETH');
	const sBTC = toBytes32('sBTC');

	const [ETH] = ['sETH'].map(toBytes32);

	const oneRenBTC = toUnit(1);
	const twoRenBTC = toUnit(2);
	const fiveRenBTC = toUnit(5);
	const tenRenBTC = toUnit(10);
	const twentyRenBTC = toUnit(20);

	const onesUSD = toUnit(1);
	const twosUSD = toUnit(2);
	const fivesUSD = toUnit(5);
	const tensUSD = toUnit(10);
	const oneHundredsUSD = toUnit(100);
	const oneThousandsUSD = toUnit(1000);
	const fiveThousandsUSD = toUnit(5000);

	let tx;
	let loan;
	let id;
	let proxy, tokenState;

	const [deployerAccount, owner, oracle, , account1, account2] = accounts;

	let cerc20,
		mcstate,
		synthetix,
		feePool,
		exchangeRates,
		addressResolver,
		sUSDSynth,
		sBTCSynth,
		renBTC,
		systemStatus,
		synths,
		manager,
		issuer,
		debtCache,
		FEE_ADDRESS;

	const getid = async tx => {
		const event = tx.logs.find(log => log.event === 'LoanCreated');
		return event.args.id;
	};

	const issuesUSDToAccount = async (issueAmount, receiver) => {
		// Set up the depositor with an amount of synths to deposit.
		await sUSDSynth.issue(receiver, issueAmount, {
			from: owner,
		});
	};

	const issuesBTCtoAccount = async (issueAmount, receiver) => {
		await sBTCSynth.issue(receiver, issueAmount, { from: owner });
	};

	const issueRenBTCtoAccount = async (issueAmount, receiver) => {
		await renBTC.transfer(receiver, issueAmount, { from: owner });
	};

	const updateRatesWithDefaults = async () => {
		const timestamp = await currentTime();

		await exchangeRates.updateRates([sETH], ['100'].map(toUnit), timestamp, {
			from: oracle,
		});

		const sBTC = toBytes32('sBTC');

		await exchangeRates.updateRates([sBTC], ['10000'].map(toUnit), timestamp, {
			from: oracle,
		});
	};

	const fastForwardAndUpdateRates = async seconds => {
		await fastForward(seconds);
		await updateRatesWithDefaults();
	};

	const deployCollateral = async ({
		proxy,
		mcState,
		owner,
		manager,
		resolver,
		collatKey,
		synths,
		minColat,
		intRate,
		liqPen,
		underCon,
	}) => {
		return setupContract({
			accounts,
			contract: 'CollateralErc20',
			args: [
				proxy,
				mcState,
				owner,
				manager,
				resolver,
				collatKey,
				synths,
				minColat,
				intRate,
				liqPen,
				underCon,
			],
		});
	};

	const setupMultiCollateral = async () => {
		synths = ['sUSD', 'sBTC'];
		({
			Synthetix: synthetix,
			SystemStatus: systemStatus,
			ExchangeRates: exchangeRates,
			SynthsUSD: sUSDSynth,
			SynthsBTC: sBTCSynth,
			FeePool: feePool,
			AddressResolver: addressResolver,
			Issuer: issuer,
			DebtCache: debtCache,
		} = await setupAllContracts({
			accounts,
			synths,
			contracts: [
				'Synthetix',
				'FeePool',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'Issuer',
				'DebtCache',
			],
		}));

		manager = await CollateralManager.new(owner, addressResolver.address, {
			from: deployerAccount,
		});

		FEE_ADDRESS = await feePool.FEE_ADDRESS();

		mcstate = await CollateralState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		// the owner is the associated contract, so we can simulate
		proxy = await ProxyERC20.new(owner, {
			from: deployerAccount,
		});
		tokenState = await TokenState.new(owner, ZERO_ADDRESS, { from: deployerAccount });

		renBTC = await PublicEST.new(
			proxy.address,
			tokenState.address,
			'Some Token',
			'TOKEN',
			toUnit('1000'),
			owner,
			{
				from: deployerAccount,
			}
		);

		await tokenState.setAssociatedContract(owner, { from: owner });
		await tokenState.setBalanceOf(owner, toUnit('1000'), { from: owner });
		await tokenState.setAssociatedContract(renBTC.address, { from: owner });

		await proxy.setTarget(renBTC.address, { from: owner });

		// Issue ren and set allowance
		await issueRenBTCtoAccount(toUnit(100), account1);

		cerc20 = await deployCollateral({
			proxy: ZERO_ADDRESS,
			mcState: mcstate.address,
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: sBTC,
			synths: [toBytes32('SynthsUSD'), toBytes32('SynthsBTC')],
			minColat: toUnit(1.5),
			// 5% / 31536000 (seconds in common year)
			intRate: 1585489599,
			liqPen: toUnit(0.1),
			underCon: renBTC.address,
		});

		await manager.addCollateral(cerc20.address, { from: owner });

		await addressResolver.importAddresses(
			[toBytes32('CollateralErc20'), toBytes32('CollateralManager')],
			[cerc20.address, manager.address],
			{
				from: owner,
			}
		);

		await mcstate.addCurrency(sUSD, { from: owner });
		await mcstate.addCurrency(sBTC, { from: owner });
		await mcstate.setAssociatedContract(cerc20.address, { from: owner });

		await feePool.setResolverAndSyncCache(addressResolver.address, { from: owner });
		await cerc20.setResolverAndSyncCache(addressResolver.address, { from: owner });
		await manager.setResolverAndSyncCache(addressResolver.address, { from: owner });
		await issuer.setResolverAndSyncCache(addressResolver.address, { from: owner });
		await debtCache.setResolverAndSyncCache(addressResolver.address, { from: owner });

		await renBTC.approve(cerc20.address, toUnit(100), { from: account1 });

		await manager.addSynth(sUSD, { from: owner });
		await manager.addSynth(sETH, { from: owner });
		await manager.addSynth(sBTC, { from: owner });
	};

	before(async () => {
		await setupMultiCollateral();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateRatesWithDefaults();

		await issuesUSDToAccount(toUnit(1000), owner);
		await issuesBTCtoAccount(toUnit(10), owner);

		await debtCache.takeDebtSnapshot();
	});

	it('should set constructor params on deployment', async () => {
		// assert.equal(await cerc20.proxy(), account1);
		assert.equal(await cerc20.state(), mcstate.address);
		assert.equal(await cerc20.owner(), owner);
		assert.equal(await cerc20.resolver(), addressResolver.address);
		assert.equal(await cerc20.collateralKey(), sBTC);
		assert.equal(await cerc20.synths(sUSD), toBytes32('SynthsUSD'));
		assert.equal(await cerc20.synths(sBTC), toBytes32('SynthsBTC'));
		assert.bnEqual(await cerc20.minimumCollateralisation(), toUnit(1.5));
		assert.bnEqual(await cerc20.baseInterestRate(), 1585489599);
		assert.bnEqual(await cerc20.liquidationPenalty(), toUnit(0.1));
		assert.bnEqual(await cerc20.debtCeiling(), toUnit(0));
		assert.equal(await cerc20.underlyingContract(), renBTC.address);
	});

	it('should ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: cerc20.abi,
			ignoreParents: ['Owned', 'Pausable', 'MixinResolver', 'Proxy', 'Collateral'],
			expected: ['open', 'close', 'deposit', 'repay', 'withdraw', 'liquidate'],
		});
	});

	it('should access its dependencies via the address resolver', async () => {
		assert.equal(await addressResolver.getAddress(toBytes32('SynthsUSD')), sUSDSynth.address);
		assert.equal(await addressResolver.getAddress(toBytes32('FeePool')), feePool.address);
		assert.equal(
			await addressResolver.getAddress(toBytes32('ExchangeRates')),
			exchangeRates.address
		);
	});

	// PUBLIC VIEW TESTS
	describe('cratio test', async () => {
		beforeEach(async () => {
			tx = await cerc20.open(oneRenBTC, fiveThousandsUSD, sUSD, {
				from: account1,
			});

			id = await getid(tx);
			loan = await mcstate.getLoan(account1, id);
		});

		it('when we issue at 200%, our c ratio is 200%', async () => {
			const ratio = await cerc20.collateralRatio(loan);
			assert.bnEqual(ratio, toUnit(2));
		});

		it('when the price falls by 25% our c ratio is 150%', async () => {
			await exchangeRates.updateRates([sBTC], ['7500'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			const ratio = await cerc20.collateralRatio(loan);
			assert.bnEqual(ratio, toUnit(1.5));
		});

		it('when the price increases by 100% our c ratio is 400%', async () => {
			await exchangeRates.updateRates([sBTC], ['20000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			const ratio = await cerc20.collateralRatio(loan);
			assert.bnEqual(ratio, toUnit(4));
		});

		it('when the price fallsby 50% our cratio is 100%', async () => {
			await exchangeRates.updateRates([sBTC], ['5000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			const ratio = await cerc20.collateralRatio(loan);
			assert.bnEqual(ratio, toUnit(1));
		});
	});

	describe('issuance ratio test', async () => {
		it('should work', async () => {
			let ratio = await cerc20.issuanceRatio();
		});
	});

	describe('max loan test', async () => {
		it('should convert correctly', async () => {
			// $150 worth of btc should allow 100 sUSD to be issued.
			const sUSDAmount = await cerc20.maxLoan(toUnit(0.015), sUSD);

			assert.bnClose(sUSDAmount, toUnit(100), 100);

			// $150 worth of btc should allow $100 (1) of sETH to be issued.
			const sETHAmount = await cerc20.maxLoan(toUnit(0.015), sETH);

			assert.bnEqual(sETHAmount, toUnit(1));
		});
	});

	describe('liquidation amount test', async () => {
		let amountToLiquidate;

		/**
		 * r = target issuance ratio
		 * D = debt balance in sUSD
		 * V = Collateral VALUE in sUSD
		 * P = liquidation penalty
		 * Calculates amount of sUSD = (D - V * r) / (1 - (1 + P) * r)
		 *
		 * To go back to another synth, remember to do effective value
		 */

		beforeEach(async () => {
			tx = await cerc20.open(oneRenBTC, fiveThousandsUSD, sUSD, {
				from: account1,
			});

			id = await getid(tx);
			loan = await mcstate.getLoan(account1, id);
		});

		it('when we start at 200%, we can take a 25% reduction in collateral prices', async () => {
			await exchangeRates.updateRates([sBTC], ['7500'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnEqual(amountToLiquidate, toUnit(0));
		});

		it('when we start at 200%, a price shock of 30% in the collateral requires 25% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([sBTC], ['7000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(1250), '10000');
		});

		it('when we start at 200%, a price shock of 40% in the collateral requires 75% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([sBTC], ['6000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(3750), '10000');
		});

		it('when we start at 200%, a price shock of 45% in the collateral requires 100% of the loan to be liquidated', async () => {
			await exchangeRates.updateRates([sBTC], ['5500'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(5000), '10000');
		});

		it('when we start at 150%, a 25% reduction in collateral requires', async () => {
			tx = await cerc20.open(toUnit(0.75), fiveThousandsUSD, sUSD, {
				from: account1,
			});

			id = await getid(tx);

			await exchangeRates.updateRates([sBTC], ['7500'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			loan = await mcstate.getLoan(account1, id);

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(4687.5), 10000);
		});

		it('when we start at 150%, any reduction in collateral will make the position undercollateralised ', async () => {
			tx = await cerc20.open(toUnit(0.75), fiveThousandsUSD, sUSD, {
				from: account1,
			});

			id = await getid(tx);
			loan = await mcstate.getLoan(account1, id);

			await exchangeRates.updateRates([sBTC], ['9000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			amountToLiquidate = await cerc20.liquidationAmount(loan);

			assert.bnClose(amountToLiquidate, toUnit(1875), 10000);
		});
	});

	describe('collateral redeemed test', async () => {
		let collateralRedeemed;

		it('when BTC is @ $10000 and we are liquidating 1000 sUSD, then redeem 0.11 BTC', async () => {
			collateralRedeemed = await cerc20.collateralRedeemed(sUSD, oneThousandsUSD);

			assert.bnEqual(collateralRedeemed, toUnit(0.11));
		});

		it('when BTC is @ $20000 and we are liquidating 1000 sUSD, then redeem 0.055 BTC', async () => {
			await exchangeRates.updateRates([sBTC], ['20000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await cerc20.collateralRedeemed(sUSD, oneThousandsUSD);

			assert.bnEqual(collateralRedeemed, toUnit(0.055));
		});

		it('when BTC is @ $7000 and we are liquidating 2500 sUSD, then redeem 0.36666 ETH', async () => {
			await exchangeRates.updateRates([sBTC], ['7000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await cerc20.collateralRedeemed(sUSD, toUnit(2500));

			assert.bnClose(collateralRedeemed, toUnit(0.392857142857142857), '100');
		});

		it('regardless of BTC price, we liquidate 1.1 * amount when doing sETH', async () => {
			collateralRedeemed = await cerc20.collateralRedeemed(sBTC, oneRenBTC);

			assert.bnEqual(collateralRedeemed, toUnit(1.1));

			await exchangeRates.updateRates([sBTC], ['1000'].map(toUnit), await currentTime(), {
				from: oracle,
			});

			collateralRedeemed = await cerc20.collateralRedeemed(sBTC, oneRenBTC);

			assert.bnEqual(collateralRedeemed, toUnit(1.1));
		});
	});

	// SETTER TESTS

	describe('setting variables', async () => {
		describe('setMinimumCollateralisation', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						cerc20.setMinimumCollateralisation(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
				it('should fail if the minimum is less than 1', async () => {
					await assert.revert(
						cerc20.setMinimumCollateralisation(toUnit(0.99), { from: owner }),
						'Minimum collateralisation must be greater than 1'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await cerc20.setMinimumCollateralisation(toUnit(2), { from: owner });
				});
				it('should update the minimum collateralisation', async () => {
					assert.bnEqual(await cerc20.minimumCollateralisation(), toUnit(2));
				});
			});
		});

		describe('setBaseInterestRate', async () => {
			describe('revert condtions', async () => {
				it('should fail if not called by the owner', async () => {
					await assert.revert(
						cerc20.setBaseInterestRate(toUnit(1), { from: account1 }),
						'Only the contract owner may perform this action'
					);
				});
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await cerc20.setBaseInterestRate(toUnit(2), { from: owner });
				});
				it('should update the base interest rate', async () => {
					assert.bnEqual(await cerc20.baseInterestRate(), toUnit(2));
				});
			});
		});

		describe('setLiquidationPenalty', async () => {
			it('should fail if not called by the owner', async () => {
				await assert.revert(
					cerc20.setLiquidationPenalty(toUnit(1), { from: account1 }),
					'Only the contract owner may perform this action'
				);
			});
			describe('when it succeeds', async () => {
				beforeEach(async () => {
					await cerc20.setLiquidationPenalty(toUnit(0.2), { from: owner });
				});
				it(' should update the liquidation penalty', async () => {
					assert.bnEqual(await cerc20.liquidationPenalty(), toUnit(0.2));
				});
			});
		});

		describe('setManager', async () => {
			it('should fail if not called by the owner', async () => {
				await assert.revert(
					cerc20.setManager(ZERO_ADDRESS, { from: account1 }),
					'Only the contract owner may perform this action'
				);
			});
		});
	});

	// LOAN INTERACTIONS

	describe('opening', async () => {
		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling openLoan() reverts', async () => {
						await assert.revert(
							cerc20.open(oneRenBTC, onesUSD, sUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling openLoan() succeeds', async () => {
							await cerc20.open(oneRenBTC, onesUSD, sUSD, {
								from: account1,
							});
						});
					});
				});
			});
			describe('when rates have gone stale', () => {
				beforeEach(async () => {
					await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
				});
				it('then calling openLoan() reverts', async () => {
					await assert.revert(
						cerc20.open(oneRenBTC, onesUSD, sUSD, { from: account1 }),
						'Blocked as collateral rate is invalid'
					);
				});
				describe('when BTC gets a rate', () => {
					beforeEach(async () => {
						await updateRatesWithDefaults();
					});
					it('then calling openLoan() succeeds', async () => {
						await cerc20.open(oneRenBTC, onesUSD, sUSD, { from: account1 });
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they request a currency that is not supported', async () => {
				await assert.revert(
					cerc20.open(oneRenBTC, onesUSD, toBytes32('sJPY'), { from: account1 }),
					'Not allowed to issue this synth'
				);
			});

			it('should revert if they send 0 collateral', async () => {
				await assert.revert(
					cerc20.open(toUnit(0), onesUSD, sUSD, { from: account1 }),
					'Not enough collateral to create a loan'
				);
			});

			it('should revert if the requested loan exceeds borrowing power', async () => {
				await assert.revert(
					cerc20.open(oneRenBTC, toUnit(10000), sUSD, {
						from: account1,
					}),
					'Loan amount exceeds max borrowing power'
				);
			});
		});

		describe('should open a btc loan denominated in sUSD', async () => {
			const fiveHundredSUSD = toUnit(500);
			const expectedMintingFee = toUnit(2.5);

			beforeEach(async () => {
				tx = await cerc20.open(oneRenBTC, fiveHundredSUSD, sUSD, {
					from: account1,
				});

				id = await getid(tx);

				loan = await mcstate.getLoan(account1, id);
			});

			it('should set the loan correctly', async () => {
				assert.equal(loan.account, account1);
				assert.equal(loan.collateral, oneRenBTC.toString());
				assert.equal(loan.currency, sUSD);
				assert.equal(loan.amount, fiveHundredSUSD.toString());
				assert.equal(loan.accruedInterest, toUnit(0));
			});

			it('should issue the correct amount to the borrower', async () => {
				const expecetdBalance = toUnit(497.5);

				assert.bnEqual(await sUSDSynth.balanceOf(account1), expecetdBalance);
			});

			it('should issue the minting fee to the fee pool', async () => {
				const feePoolBalance = await sUSDSynth.balanceOf(FEE_ADDRESS);

				assert.equal(expectedMintingFee, feePoolBalance.toString());
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanCreated', {
					account: account1,
					id: id,
					amount: fiveHundredSUSD,
					collateral: oneRenBTC,
					currency: sUSD,
				});
			});
		});

		describe('should open a btc loan denominated in sBTC', async () => {
			beforeEach(async () => {
				tx = await cerc20.open(fiveRenBTC, twoRenBTC, sBTC, {
					from: account1,
				});

				id = await getid(tx);

				loan = await mcstate.getLoan(account1, id);
			});

			it('should set the loan correctly', async () => {
				assert.equal(loan.account, account1);
				assert.equal(loan.collateral, fiveRenBTC.toString());
				assert.equal(loan.currency, sBTC);
				assert.equal(loan.amount, twoRenBTC.toString());
				assert.equal(loan.accruedInterest, toUnit(0));
			});

			it('should issue the correct amount to the borrower', async () => {
				const expecetdBalance = toUnit(1.99);

				assert.bnEqual(await sBTCSynth.balanceOf(account1), expecetdBalance);
			});

			it('should issue the minting fee to the fee pool', async () => {
				const feePoolBalance = await sUSDSynth.balanceOf(FEE_ADDRESS);

				const expecetdBalance = toUnit(100);

				assert.equal(expecetdBalance, feePoolBalance.toString());
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanCreated', {
					account: account1,
					id: id,
					amount: twoRenBTC,
					collateral: fiveRenBTC,
					currency: sBTC,
				});
			});
		});
	});

	describe('deposits', async () => {
		beforeEach(async () => {
			tx = await cerc20.open(twoRenBTC, oneHundredsUSD, sUSD, {
				from: account1,
			});

			id = await getid(tx);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling depopsit() reverts', async () => {
						await assert.revert(
							cerc20.deposit(account1, id, oneRenBTC, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling deposit() succeeds', async () => {
							await cerc20.deposit(account1, id, oneRenBTC, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they do not send any eth', async () => {
				await assert.revert(
					cerc20.deposit(account1, id, 0, { from: account1 }),
					'Deposit must be greater than 0'
				);
			});
		});

		describe('should allow deposits', async () => {
			beforeEach(async () => {
				await cerc20.deposit(account1, id, oneRenBTC, { from: account1 });
			});

			it('should increase the total collateral of the loan', async () => {
				loan = await mcstate.getLoan(account1, id);

				assert.bnEqual(loan.collateral, toUnit(3));
			});
		});
	});

	describe('withdraws', async () => {
		beforeEach(async () => {
			loan = await cerc20.open(twoRenBTC, oneHundredsUSD, sUSD, {
				from: account1,
			});

			id = await getid(loan);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling depopsit() reverts', async () => {
						await assert.revert(
							cerc20.withdraw(id, oneRenBTC, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling deposit() succeeds', async () => {
							cerc20.withdraw(id, oneRenBTC, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they try to withdraw 0', async () => {
				await assert.revert(
					cerc20.withdraw(id, 0, { from: account1 }),
					'Amount to withdraw must be greater than 0'
				);
			});

			it('should revert if the withdraw would put them under minimum collateralisation', async () => {
				const lol = toUnit(1.999);

				await assert.revert(
					cerc20.withdraw(id, lol, { from: account1 }),
					'Collateral ratio below liquidation after withdraw'
				);
			});

			it('should revert if they try to withdraw all the collateral', async () => {
				await assert.revert(
					cerc20.withdraw(id, twoRenBTC, { from: account1 }),
					'Request exceeds total collateral'
				);
			});

			it('should revert if the sender is not borrower', async () => {
				await issuesBTCtoAccount(oneRenBTC, account2);
				await renBTC.approve(cerc20.address, oneRenBTC, { from: account2 });

				await assert.revert(cerc20.withdraw(id, oneRenBTC, { from: account2 }));
			});
		});

		describe('should allow withdraws', async () => {
			beforeEach(async () => {
				await cerc20.withdraw(id, oneRenBTC, {
					from: account1,
				});
			});

			it('should decrease the total collateral of the loan', async () => {
				loan = await mcstate.getLoan(account1, id);

				const expectedCollateral = twoRenBTC.sub(oneRenBTC);

				assert.bnEqual(loan.collateral, expectedCollateral);
			});
		});
	});

	describe('repayments', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await cerc20.open(twoRenBTC, oneHundredsUSD, sUSD, {
				from: account1,
			});

			id = await getid(tx);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling repay() reverts', async () => {
						await assert.revert(
							cerc20.repay(account1, id, onesUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling repay() succeeds', async () => {
							cerc20.repay(account1, id, onesUSD, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they try to repay 0', async () => {
				await assert.revert(
					cerc20.repay(account1, id, 0, { from: account1 }),
					'Payment must be greater than 0'
				);
			});

			// account 2 had no sUSD
			it('should revert if they have no sUSD', async () => {
				await assert.revert(
					cerc20.repay(account1, id, tensUSD, { from: account2 }),
					'Not enough synth balance'
				);
			});

			it('should revert if they try to pay more than the amount owing', async () => {
				await issuesUSDToAccount(toUnit(1000), account1);
				await assert.revert(
					cerc20.repay(account1, id, toUnit(1000), { from: account1 }),
					'Repayment would close loan. If you are the borrower then call close loan'
				);
			});
		});

		describe('should allow repayments on an sUSD loan', async () => {
			const expected = new BN('90000000323366715800');

			// I don't want to test interest here. I just want to test repayment.
			beforeEach(async () => {
				await issuesUSDToAccount(oneHundredsUSD, account2);
				tx = await cerc20.repay(account1, id, tensUSD, { from: account2 });
			});

			it('should work reduce the repayers balance', async () => {
				const expectedBalance = toUnit(90);
				assert.bnEqual(await sUSDSynth.balanceOf(account2), expectedBalance);
			});

			it('should update the loan', async () => {
				loan = await mcstate.getLoan(account1, id);

				assert.equal(loan.amount, expected);
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanRepaymentMade', {
					account: account1,
					repayer: account2,
					id: id,
					repaidAmount: tensUSD,
					newLoanAmount: expected,
				});
			});
		});

		describe('it should allow repayments on an sBTC loan', async () => {
			const expected = new BN('1000000027380576684');

			beforeEach(async () => {
				tx = await cerc20.open(fiveRenBTC, twoRenBTC, sBTC, {
					from: account1,
				});

				id = await getid(tx);

				loan = await mcstate.getLoan(account1, id);

				await issuesBTCtoAccount(twoRenBTC, account2);

				tx = await cerc20.repay(account1, id, oneRenBTC, { from: account2 });
			});

			it('should work reduce the repayers balance', async () => {
				const expectedBalance = oneRenBTC;

				assert.bnEqual(await sBTCSynth.balanceOf(account2), expectedBalance);
			});

			it('should update the loan', async () => {
				loan = await mcstate.getLoan(account1, id);

				assert.equal(loan.amount, expected);
			});

			it('should emit the event properly', async () => {
				assert.eventEqual(tx, 'LoanRepaymentMade', {
					account: account1,
					repayer: account2,
					id: id,
					repaidAmount: oneRenBTC,
					newLoanAmount: expected,
				});
			});
		});
	});

	describe('liquidations', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await cerc20.open(oneRenBTC, toUnit(5000), sUSD, {
				from: account1,
			});

			id = await getid(tx);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling repay() reverts', async () => {
						await assert.revert(
							cerc20.liquidate(account1, id, onesUSD, { from: account1 }),
							'Operation prohibited'
						);
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling liquidate() succeeds', async () => {
							// fast forward a long time to make sure the loan is underwater.
							await fastForwardAndUpdateRates(10 * YEAR);
							await cerc20.liquidate(account1, id, onesUSD, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they have no sUSD', async () => {
				await assert.revert(
					cerc20.liquidate(account1, id, onesUSD, { from: account2 }),
					'Not enough synth balance'
				);
			});

			it('should revert if they are not under collateralised', async () => {
				await issuesUSDToAccount(toUnit(100), account2);

				await assert.revert(
					cerc20.liquidate(account1, id, onesUSD, { from: account2 }),
					'Collateral ratio above liquidation ratio'
				);
			});
		});

		describe('should allow liquidations on an undercollateralised sUSD loan', async () => {
			const liquidatedCollateral = new BN('196428571428571428');
			let liquidationAmount;

			beforeEach(async () => {
				const timestamp = await currentTime();
				await exchangeRates.updateRates([sBTC], ['7000'].map(toUnit), timestamp, {
					from: oracle,
				});

				await issuesUSDToAccount(toUnit(5000), account2);

				loan = await mcstate.getLoan(account1, id);

				liquidationAmount = await cerc20.liquidationAmount(loan);

				tx = await cerc20.liquidate(account1, id, liquidationAmount, {
					from: account2,
				});
			});

			it('should update the loan correctly', async () => {
				loan = await mcstate.getLoan(account1, id);

				const expectedAmount = toUnit(loan.amount).sub(liquidationAmount);

				// assert.bnClose(loan.amount, expectedAmount, 100);
				// assert.bnEqual(loan.collateral, remainingCollateral);
			});

			it('should emit a liquidation event', async () => {
				assert.eventEqual(tx, 'LoanPartiallyLiquidated', {
					account: account1,
					id: id,
					liquidator: account2,
					liquidatedAmount: liquidationAmount,
					liquidatedCollateral: liquidatedCollateral,
				});
			});

			it('should reduce the liquicators synth amount', async () => {
				const liquidatorBalance = await sUSDSynth.balanceOf(account2);
				const expectedBalance = toUnit(5000).sub(liquidationAmount);

				assert.bnEqual(liquidatorBalance, expectedBalance);
			});

			xit('should transfer the liquidated collateral to the liquidator', async () => {
				// the actual amount of eth is different because of gas spent on transactions
				// so we just check that they have more eth now
				liquidatorEthBalAfter = new BN(await getEthBalance(account2)).add(liquidatedCollateral);

				assert.bnClose(liquidatorEthBalAfter, liquidatorEthBalBefore);
			});

			it('should pay the interest to the fee pool', async () => {
				const balance = await sUSDSynth.balanceOf(FEE_ADDRESS);

				assert.bnGt(balance, toUnit(0));
			});

			xit('should fix the collateralisation ratio of the loan', async () => {
				loan = await mcstate.getLoan(account1, id);

				const ratio = await mcerc20.collateralRatio(loan);

				assert.bnGte(ratio, toUnit(1.5));
			});
		});

		describe('when a loan needs to be completely liquidated', async () => {
			let liquidatorEthBalBefore;

			beforeEach(async () => {
				const timestamp = await currentTime();
				await exchangeRates.updateRates([sBTC], ['5000'].map(toUnit), timestamp, {
					from: oracle,
				});

				await issuesUSDToAccount(toUnit(10000), account2);

				liquidatorEthBalBefore = parseFloat(fromUnit(await getEthBalance(account2)));
				const liquidatorsUSDBalBefore = await sUSDSynth.balanceOf(account2);


				tx = await cerc20.liquidate(account1, id, toUnit(10000), {
					from: account2,
				});
			});

			it('should emit the event', async () => {
				assert.eventEqual(tx, 'LoanClosedByLiquidation', {
					liquidator: account2,
					collateral: oneRenBTC,
				});
			});

			it('should close the loan correctly', async () => {
				loan = await mcstate.getLoan(account1, id);

				assert.equal(loan.amount, 0);
				assert.equal(loan.collateral, 0);
				assert.equal(loan.interestIndex, 0);
			});

			it('should transfer all the collateral to the liquidator', async () => {
				// assert.bnGt(liquidatorBal, liquidatorEthBalBefore);
			});

			it('should reduce the liquidators synth balance', async () => {
				// const liquidatorsUSDBalAfter = await sUSDSynth.balanceOf(account2);
			});
		});
	});

	describe('closing', async () => {
		beforeEach(async () => {
			// make a loan here so we have a valid ID to pass to the blockers and reverts.
			tx = await cerc20.open(twoRenBTC, oneHundredsUSD, sUSD, {
				from: account1,
			});

			id = await getid(tx);
		});

		describe('potential blocking conditions', async () => {
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling close() reverts', async () => {
						await assert.revert(cerc20.close(id, { from: account1 }), 'Operation prohibited');
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling close() succeeds', async () => {
							// Give them some more sUSD to make up for the fees.
							await issuesUSDToAccount(tensUSD, account1);
							await cerc20.close(id, { from: account1 });
						});
					});
				});
			});
		});

		describe('revert conditions', async () => {
			it('should revert if they have no sUSD', async () => {
				await assert.revert(cerc20.close(id, { from: account1 }), 'Not enough synth balance');
			});

			it('should revert if they are not the borrower', async () => {
				await assert.revert(cerc20.close(id, { from: account2 }), 'Loan does not exist');
			});
		});

		describe('when it works', async () => {
			beforeEach(async () => {
				// Give them some more sUSD to make up for the fees.
				await issuesUSDToAccount(tensUSD, account1);

				tx = await cerc20.close(id, { from: account1 });
			});

			it('should record the loan as closed', async () => {
				loan = await mcstate.getLoan(account1, id);

				assert.equal(loan.amount, 0);
				assert.equal(loan.collateral, 0);
				assert.equal(loan.accruedInterest, 0);
				assert.equal(loan.interestIndex, 0);
			});

			it('should pay the fee pool', async () => {
				const balance = await sUSDSynth.balanceOf(FEE_ADDRESS);

				assert.bnGt(balance, toUnit(0));
			});

			it('should transfer the collateral back to the borrower', async () => {
				// assert.closeTo(liquidatorEthBalBefore, liquidatorEthBalAfter);
			});

			it('should emit the event', async () => {
				assert.eventEqual(tx, 'LoanClosed', {
					account: account1,
					id: id,
				});
			});
		});
	});
});
